"""
Occupancy Module — Absorbed from STP_Occupancy (Phase 6 consolidation).

Scans CSV files exported by Camlytics (BuildingOccupancy/ and CommunionCounts/
sub-folders), parses weekly trends, communion counts, occupancy pacing, and
participation ratios.  Also downloads CSVs from Camlytics cloud on a daily
schedule (replacing the Windows Scheduled Task scripts).

All configuration comes from the ``occupancy:`` section in config.yaml.
"""

from __future__ import annotations

import os
import re
import threading
import time
import logging
from datetime import datetime, date, time as dt_time
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
import requests as http_requests


class OccupancyModule:
    """CSV-based occupancy analytics with background scheduler."""

    def __init__(self, cfg: dict, logger: logging.Logger, db=None):
        self.log = logger
        self.db = db
        occ = cfg.get("occupancy", {})

        # Directories
        self.data_dir = occ.get("data_dir", r"C:\Users\info\Box\Reports")
        self.building_subdir = occ.get("building_subdir", "BuildingOccupancy")
        self.communion_subdir = occ.get("communion_subdir", "CommunionCounts")

        # Default time windows
        self.service_hour_start = int(occ.get("service_hour_start", 7))
        self.service_hour_end = int(occ.get("service_hour_end", 22))
        self.communion_window_start = self._parse_time(str(occ.get("communion_window_start", "10:30")))
        self.communion_window_end = self._parse_time(str(occ.get("communion_window_end", "12:15")))
        self.occupancy_pacing_start = self._parse_time(str(occ.get("occupancy_pacing_start", "08:30")))
        self.occupancy_pacing_end = self._parse_time(str(occ.get("occupancy_pacing_end", "12:30")))

        # Buffer schedule
        self.buffer_schedule = occ.get("buffer_schedule", [
            {"effective_date": "2000-01-01", "occupancy_buffer": 0.15, "communion_buffer": 0.05},
        ])

        # Special services (non-Sunday dates with custom windows)
        self.special_services: Dict[date, dict] = {}
        for entry in occ.get("special_services", []):
            d = date.fromisoformat(str(entry["date"]))
            self.special_services[d] = entry

        # CSV download URLs
        csv_urls = occ.get("csv_download_urls", {})
        self.building_csv_url = csv_urls.get("building", "")
        self.communion_csv_url = csv_urls.get("communion", "")

        # Scheduler config
        self.daily_reload_time = str(occ.get("daily_reload_time", "01:00"))

        # Cached data
        self._lock = threading.Lock()
        self._data: dict = {}
        self._stop = threading.Event()

    def _audit(self, action: str, target: str, result: str = ""):
        """Write an entry to the audit log (if db is available)."""
        if self.db:
            try:
                self.db.log_action("Gateway", action, target, "", result)
            except Exception:
                pass

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def start(self):
        """Start the background scheduler thread."""
        t = threading.Thread(target=self._scheduler_loop, daemon=True, name="occupancy-scheduler")
        t.start()
        self.log.info("[occupancy] Module started")

    def stop(self):
        self._stop.set()

    # ── Public API ───────────────────────────────────────────────────────────

    def get_data(self) -> dict:
        """Return cached weekly summary, trends, pacing data."""
        with self._lock:
            return dict(self._data)

    def get_config(self) -> dict:
        """Return buffer schedule + windows for the frontend."""
        return {
            "data_dir": str(Path(self.data_dir).resolve()) if os.path.isdir(self.data_dir) else self.data_dir,
            "buffer_schedule": self.buffer_schedule,
            "communion_window": {
                "start": self.communion_window_start.strftime("%H:%M"),
                "end": self.communion_window_end.strftime("%H:%M"),
            },
            "occupancy_pacing_window": {
                "start": self.occupancy_pacing_start.strftime("%H:%M"),
                "end": self.occupancy_pacing_end.strftime("%H:%M"),
            },
        }

    def refresh_data(self):
        """Re-scan the data directory and cache results."""
        if not os.path.isdir(self.data_dir):
            with self._lock:
                self._data = {"error": f"Directory not found: {self.data_dir}"}
            return

        building_files, communion_files = self._scan_data_dir()
        service_dates = set(communion_files.keys())
        occupancy = self._service_peak_occupancy(building_files, service_dates)
        communion = self._service_communion_totals(communion_files)
        weekly = self._build_weekly_summary(occupancy, communion)

        all_daily_peaks = []
        for d, path in sorted(building_files.items()):
            try:
                df = self._parse_building_file(path)
                raw_peak = int(df["occupancy"].max())
                occ_buf, _ = self._get_buffer_for_date(d)
                peak = self._apply_buffer(raw_peak, occ_buf)
                all_daily_peaks.append({
                    "date": d.isoformat(),
                    "peak": peak,
                    "raw_peak": raw_peak,
                    "weekday": d.strftime("%A"),
                })
            except Exception:
                pass

        result = {
            "weekly_summary": weekly,
            "occupancy_trend": occupancy,
            "all_daily_peaks": all_daily_peaks,
            "data_dir": str(Path(self.data_dir).resolve()),
            "scanned_at": datetime.now().isoformat(),
            "buffer_schedule": self.buffer_schedule,
            "communion_window": {
                "start": self.communion_window_start.strftime("%H:%M"),
                "end": self.communion_window_end.strftime("%H:%M"),
            },
            "occupancy_pacing_window": {
                "start": self.occupancy_pacing_start.strftime("%H:%M"),
                "end": self.occupancy_pacing_end.strftime("%H:%M"),
            },
        }

        with self._lock:
            self._data = result

        self.log.info(f"[occupancy] Data refreshed: {len(weekly)} service(s), "
                      f"{len(all_daily_peaks)} daily peak(s)")

    def download_csvs(self):
        """Download CSVs from Camlytics cloud and save to data directory."""
        today = datetime.now().strftime("%Y-%m-%d")

        if self.building_csv_url:
            self._download_csv(
                self.building_csv_url,
                os.path.join(self.data_dir, self.building_subdir),
                f"Camlytics_BuildingOccupancy_{today}.csv",
            )
        if self.communion_csv_url:
            self._download_csv(
                self.communion_csv_url,
                os.path.join(self.data_dir, self.communion_subdir),
                f"Camlytics_Communion_{today}.csv",
            )

    # ── Background scheduler ─────────────────────────────────────────────────

    def _scheduler_loop(self):
        reload_h, reload_m = [int(x) for x in self.daily_reload_time.split(":")]
        last_reload_date = None

        # Initial load
        try:
            self.refresh_data()
            self.log.info("[occupancy] Initial data load complete")
        except Exception as e:
            self.log.error(f"[occupancy] Initial data load failed: {e}")

        while not self._stop.is_set():
            now = datetime.now()
            today = now.date()

            if (now.hour == reload_h and now.minute == reload_m
                    and last_reload_date != today):
                last_reload_date = today
                try:
                    self.log.info("[occupancy] Daily scheduled download + reload")
                    self.download_csvs()
                    self.refresh_data()
                    self._audit("occupancy:download", "daily_reload", result="OK")
                except Exception as e:
                    self.log.error(f"[occupancy] Scheduled reload failed: {e}")
                    self._audit("occupancy:download", "daily_reload", result=f"FAIL: {e}")

            self._stop.wait(30)

    # ── CSV download ─────────────────────────────────────────────────────────

    def _download_csv(self, url: str, save_dir: str, filename: str):
        try:
            os.makedirs(save_dir, exist_ok=True)
            resp = http_requests.get(url, timeout=30)
            resp.raise_for_status()
            full_path = os.path.join(save_dir, filename)
            with open(full_path, "wb") as f:
                f.write(resp.content)
            self.log.info(f"[occupancy] Downloaded {filename} to {save_dir}")
        except Exception as e:
            self.log.error(f"[occupancy] CSV download failed ({filename}): {e}")

    # ── File parsing ─────────────────────────────────────────────────────────

    @staticmethod
    def _parse_time(s: str) -> dt_time:
        h, m = s.split(":")
        return dt_time(int(h), int(m))

    @staticmethod
    def _parse_building_file(path: Path) -> pd.DataFrame:
        df = pd.read_csv(path)
        df.columns = [c.strip().strip('"') for c in df.columns]
        df["datetime"] = pd.to_datetime(df["Date"].str.strip('"'))
        df["occupancy"] = pd.to_numeric(df["Peak Occupancy"], errors="coerce").fillna(0)
        return df[["datetime", "occupancy"]]

    @staticmethod
    def _parse_communion_file(path: Path) -> pd.DataFrame:
        df = pd.read_csv(path)
        df.columns = [c.strip().strip('"') for c in df.columns]
        df["datetime"] = pd.to_datetime(df["Date"].str.strip('"'))
        df["count"] = pd.to_numeric(df["Communion Count"], errors="coerce").fillna(0)
        return df[["datetime", "count"]]

    def _scan_data_dir(self):
        p = Path(self.data_dir)
        building_files = {}
        communion_files = {}

        building_dir = p / self.building_subdir
        communion_dir = p / self.communion_subdir

        if building_dir.is_dir():
            for f in building_dir.glob("*.csv"):
                m = re.match(r"Camlytics_BuildingOccupancy_(\d{4}-\d{2}-\d{2})\.csv", f.name)
                if m:
                    d = date.fromisoformat(m.group(1))
                    building_files[d] = f

        if communion_dir.is_dir():
            for f in communion_dir.glob("*.csv"):
                m = re.match(r"Camlytics_Communion_(\d{4}-\d{2}-\d{2})\.csv", f.name)
                if m:
                    d = date.fromisoformat(m.group(1))
                    communion_files[d] = f

        return building_files, communion_files

    # ── Buffer helpers ───────────────────────────────────────────────────────

    def _get_buffer_for_date(self, d: date):
        applicable = None
        for entry in sorted(self.buffer_schedule, key=lambda e: e["effective_date"]):
            if d >= date.fromisoformat(str(entry["effective_date"])):
                applicable = entry
        if applicable is None:
            return (0.0, 0.0)
        return (applicable["occupancy_buffer"], applicable["communion_buffer"])

    @staticmethod
    def _apply_buffer(raw_value, buffer_pct):
        return round(raw_value * (1 + buffer_pct))

    # ── Service windows ──────────────────────────────────────────────────────

    def _get_service_windows(self, d: date):
        special = self.special_services.get(d)
        if special:
            return (
                self._parse_time(str(special.get("communion_window_start", "10:30"))),
                self._parse_time(str(special.get("communion_window_end", "12:15"))),
                self._parse_time(str(special.get("occupancy_pacing_start", "08:30"))),
                self._parse_time(str(special.get("occupancy_pacing_end", "12:30"))),
                int(special.get("service_hour_start", self.service_hour_start)),
                int(special.get("service_hour_end", self.service_hour_end)),
                str(special.get("label", "")),
            )
        return (self.communion_window_start, self.communion_window_end,
                self.occupancy_pacing_start, self.occupancy_pacing_end,
                self.service_hour_start, self.service_hour_end, "")

    # ── Data processing ──────────────────────────────────────────────────────

    def _service_peak_occupancy(self, building_files: dict, service_dates: set) -> list:
        results = []
        for d, path in sorted(building_files.items()):
            if d not in service_dates:
                continue
            try:
                comm_start, comm_end, pacing_start, pacing_end, svc_h_start, svc_h_end, label = self._get_service_windows(d)
                df = self._parse_building_file(path)
                service = df[(df["datetime"].dt.hour >= svc_h_start) &
                             (df["datetime"].dt.hour < svc_h_end)]
                raw_peak = int(service["occupancy"].max()) if not service.empty else 0
                occ_buf, _ = self._get_buffer_for_date(d)
                buffered_peak = self._apply_buffer(raw_peak, occ_buf)

                pacing_mask = (
                    (df["datetime"].dt.time >= pacing_start) &
                    (df["datetime"].dt.time <= pacing_end)
                )
                pacing_df = df[pacing_mask]
                occ_pacing = [
                    {"time": row["datetime"].strftime("%H:%M"),
                     "count": self._apply_buffer(int(row["occupancy"]), occ_buf)}
                    for _, row in pacing_df.iterrows()
                    if row["occupancy"] > 0
                ]

                results.append({
                    "date": d.isoformat(),
                    "label": label,
                    "peak_occupancy": buffered_peak,
                    "raw_peak_occupancy": raw_peak,
                    "occupancy_buffer_pct": occ_buf,
                    "occupancy_pacing": occ_pacing,
                })
            except Exception as e:
                self.log.warning(f"[occupancy] Error reading {path}: {e}")
        return results

    def _service_communion_totals(self, communion_files: dict) -> list:
        results = []
        for d, path in sorted(communion_files.items()):
            try:
                comm_start, comm_end, pacing_start, pacing_end, svc_h_start, svc_h_end, label = self._get_service_windows(d)
                df = self._parse_communion_file(path)
                window_mask = (
                    (df["datetime"].dt.time >= comm_start) &
                    (df["datetime"].dt.time <= comm_end)
                )
                windowed = df[window_mask]
                raw_total = int(windowed["count"].sum())
                _, comm_buf = self._get_buffer_for_date(d)
                buffered_total = self._apply_buffer(raw_total, comm_buf)

                pacing = [
                    {"time": row["datetime"].strftime("%H:%M"),
                     "count": self._apply_buffer(int(row["count"]), comm_buf)}
                    for _, row in windowed.iterrows()
                    if row["count"] > 0
                ]

                results.append({
                    "date": d.isoformat(),
                    "label": label,
                    "total_communion": buffered_total,
                    "raw_total_communion": raw_total,
                    "communion_buffer_pct": comm_buf,
                    "pacing": pacing,
                })
            except Exception as e:
                self.log.warning(f"[occupancy] Error reading {path}: {e}")
        return results

    @staticmethod
    def _build_weekly_summary(occupancy_list, communion_list):
        occ_by_date = {r["date"]: r for r in occupancy_list}
        summary = []
        for comm in communion_list:
            d = comm["date"]
            occ_entry = occ_by_date.get(d, {})
            occ = occ_entry.get("peak_occupancy")
            raw_occ = occ_entry.get("raw_peak_occupancy")
            occ_buf = occ_entry.get("occupancy_buffer_pct", 0)
            occ_pacing = occ_entry.get("occupancy_pacing", [])
            label = comm.get("label") or occ_entry.get("label") or ""
            ratio = round(comm["total_communion"] / occ, 2) if occ else None
            summary.append({
                "date": d,
                "label": label,
                "peak_occupancy": occ,
                "raw_peak_occupancy": raw_occ,
                "occupancy_buffer_pct": occ_buf,
                "total_communion": comm["total_communion"],
                "raw_total_communion": comm["raw_total_communion"],
                "communion_buffer_pct": comm["communion_buffer_pct"],
                "ratio": ratio,
                "pacing": comm["pacing"],
                "occupancy_pacing": occ_pacing,
            })
        return summary
