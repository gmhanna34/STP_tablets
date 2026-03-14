"""
Health Module — Service health monitoring absorbed from STP_healthdash.

Absorbed from STP_healthdash/app.py (Phase 4 of the consolidation plan).
Replaces the standalone Flask+Waitress health dashboard that ran on port 20855.

Key design:
- Background checker_loop thread polls all configured services on their own intervals.
- Two-pass approach: atomic checks first, then composite aggregations.
- Supports 9 check types: http, http_json, tcp, process, process_and_tcp,
  obs_rpc, ffprobe_rtsp, composite, heartbeat_group.
- Home Assistant webhook alerts with debounced thresholds.
- Recovery actions via HA service calls.
- Log tailing from local files or remote URLs.
- Thread-safe: all state behind STATE_LOCK.
"""

from __future__ import annotations

import logging
import os
import socket
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import psutil
import requests


# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass
class ServiceResult:
    id: str
    name: str
    status: Dict[str, str] = field(default_factory=lambda: {"level": "down", "label": "Unknown"})
    message: str = ""
    checked_at: Optional[str] = None
    last_ok_at: Optional[str] = None
    latency_ms: Optional[float] = None
    details: Optional[Dict[str, Any]] = None

    def to_dict(self) -> dict:
        return asdict(self)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _level_label(level: str) -> Dict[str, str]:
    labels = {"healthy": "Healthy", "warning": "Warning", "down": "Down"}
    return {"level": level, "label": labels.get(level, "Unknown")}


# =============================================================================
# HEALTH MODULE
# =============================================================================

class HealthModule:
    """Encapsulates all health monitoring logic from STP_healthdash."""

    def __init__(self, cfg: dict, logger: logging.Logger):
        self._cfg = cfg
        self._logger = logger

        hd = cfg.get("healthdash", {})
        self._app_cfg = hd.get("app", {})
        self._ha_cfg = hd.get("home_assistant", {})
        self._alerts_cfg = hd.get("alerts", {})
        self._services_cfg: List[dict] = hd.get("services", [])
        self._security_cfg = hd.get("security", {})

        self._default_timeout = float(self._app_cfg.get("request_timeout_seconds", 7))
        self._default_interval = float(self._app_cfg.get("check_interval_seconds", 10))
        self._client_id = self._app_cfg.get("client_id", "Health Check")

        # Build service lookup
        self._svc_by_id: Dict[str, dict] = {}
        for svc in self._services_cfg:
            self._svc_by_id[svc["id"]] = svc

        # Thread-safe state
        self._lock = threading.Lock()
        self._results: Dict[str, ServiceResult] = {}
        self._heartbeats: Dict[str, float] = {}
        self._alert_state: Dict[str, dict] = {}
        self._next_due: Dict[str, float] = {}
        self._force_check = threading.Event()
        self._on_summary_change = None  # Optional callback(summary_dict)

        self._running = False

        # Calendar feed cache for schedule-aware alerting
        self._calendar_cache: Dict[str, List[dict]] = {}  # url -> [{start, end}, ...]
        self._calendar_fetched_at: Dict[str, float] = {}  # url -> timestamp
        self._calendar_fetch_interval = 3600  # re-fetch hourly

    # -------------------------------------------------------------------------
    # PUBLIC API
    # -------------------------------------------------------------------------

    def start(self):
        """Start the background checker thread."""
        if self._running:
            return
        self._running = True
        t = threading.Thread(target=self._checker_loop, daemon=True)
        t.start()
        self._logger.info(f"Health module started: {len(self._services_cfg)} services configured")

    def stop(self):
        """Stop the background checker thread."""
        self._running = False

    def get_all_results(self) -> Dict[str, dict]:
        """Return all service results as dicts."""
        with self._lock:
            return {k: v.to_dict() for k, v in self._results.items()}

    def get_summary(self) -> dict:
        """Return lightweight summary counts (for tablet status bar)."""
        with self._lock:
            results = dict(self._results)

        # Count leaves only (exclude composite parents, avoid double-counting members)
        member_ids = set()
        for svc_id, result in results.items():
            if result.details and isinstance(result.details.get("member_rows"), list):
                for row in result.details["member_rows"]:
                    if row.get("id"):
                        member_ids.add(row["id"])

        counts = {"healthy": 0, "warning": 0, "down": 0}
        for svc_id, result in results.items():
            is_composite = result.details and isinstance(result.details.get("member_rows"), list)
            if is_composite:
                # Count member rows
                for row in result.details["member_rows"]:
                    level = row.get("level", "down")
                    counts[level] = counts.get(level, 0) + 1
            elif svc_id not in member_ids:
                level = result.status.get("level", "down")
                counts[level] = counts.get(level, 0) + 1

        total = sum(counts.values())
        return {
            "generated_at": _now_iso(),
            "counts": counts,
            "total": total,
        }

    def record_heartbeat(self, tablet_id: str, payload: dict = None):
        """Record a tablet heartbeat."""
        with self._lock:
            self._heartbeats[tablet_id] = time.time()
        self._logger.debug(f"Health heartbeat: tablet_id={tablet_id}")

    def get_heartbeats(self) -> dict:
        """Return heartbeat data."""
        now = time.time()
        with self._lock:
            hb = dict(self._heartbeats)
        return {
            "count": len(hb),
            "tablets": {tid: round(now - ts, 1) for tid, ts in hb.items()},
        }

    def force_check_now(self):
        """Trigger an immediate check of all services."""
        self._force_check.set()

    def get_service_logs(self, service_id: str, lines: int = 200) -> dict:
        """Fetch logs for a service (from local file or remote URL)."""
        svc = self._svc_by_id.get(service_id)
        if not svc:
            return {"service_id": service_id, "name": "Unknown", "lines": 0, "log": "Service not found"}

        name = svc.get("name", service_id)
        log_path = svc.get("log_path", "")
        log_url = svc.get("log_url", "")

        if log_path and os.path.isfile(log_path):
            text = self._tail_file(log_path, lines)
        elif log_url:
            text = self._fetch_log_from_url(svc, lines)
        else:
            text = "(No log source configured for this service)"

        return {"service_id": service_id, "name": name, "lines": lines, "log": text}

    def trigger_recovery(self, service_id: str) -> dict:
        """Trigger a recovery action for a service."""
        svc = self._svc_by_id.get(service_id)
        if not svc:
            return {"ok": False, "message": f"Unknown service: {service_id}"}

        recovery = svc.get("recovery")
        if not recovery or recovery.get("type") != "ha_service":
            return {"ok": False, "message": f"No recovery action configured for {service_id}"}

        domain = recovery.get("domain", "")
        service = recovery.get("service", "")
        service_data = recovery.get("service_data", {})

        ok = self._ha_call_service(domain, service, service_data)
        if ok:
            self._logger.info(f"Health recovery triggered: {service_id} -> {domain}/{service}")
            return {"ok": True, "message": f"Recovery triggered for {svc.get('name', service_id)}"}
        else:
            return {"ok": False, "message": f"Recovery call failed for {service_id}"}

    def get_services_for_ui(self) -> list:
        """Return service definitions for the frontend template."""
        visible = []
        for svc in self._services_cfg:
            show = svc.get("show_standalone", True)
            if not show:
                continue
            visible.append({
                "id": svc["id"],
                "name": svc.get("name", svc["id"]),
                "type": svc.get("type", ""),
                "group": svc.get("group", ""),
                "recovery": svc.get("recovery"),
            })
        return visible

    # -------------------------------------------------------------------------
    # CHECKER LOOP
    # -------------------------------------------------------------------------

    def _checker_loop(self):
        """Background thread: poll services on their configured intervals."""
        # Initialize next_due for all services
        now = time.time()
        for svc in self._services_cfg:
            self._next_due[svc["id"]] = now

        heartbeat_counter = 0

        while self._running:
            # Check if force refresh requested
            if self._force_check.is_set():
                self._force_check.clear()
                now = time.time()
                for sid in self._next_due:
                    self._next_due[sid] = now

            now = time.time()
            ran_any_leaf = False

            # Pass 1: Run non-composite, non-heartbeat_group services that are due
            for svc in self._services_cfg:
                sid = svc["id"]
                stype = svc.get("type", "")
                if stype in ("composite", "heartbeat_group"):
                    continue
                if now < self._next_due.get(sid, 0):
                    continue

                interval = float(svc.get("poll_interval_seconds", self._default_interval))
                self._next_due[sid] = now + interval

                result = self._run_check(svc)
                # Schedule-aware: downgrade "down" to "expected_off" outside operating windows
                if result.status.get("level") == "down" and not self._is_in_schedule_window(svc):
                    result.status = {"level": "expected_off", "label": "Expected Off"}
                    result.message = "Outside scheduled operating window"
                with self._lock:
                    self._results[sid] = result
                self._maybe_fire_alert(svc, result)
                ran_any_leaf = True

            # Pass 2: Run composites and heartbeat_groups
            for svc in self._services_cfg:
                sid = svc["id"]
                stype = svc.get("type", "")

                if stype == "composite":
                    if ran_any_leaf or now >= self._next_due.get(sid, 0):
                        interval = float(svc.get("poll_interval_seconds", self._default_interval))
                        self._next_due[sid] = now + interval
                        result = self._run_composite(svc)
                        with self._lock:
                            self._results[sid] = result
                        self._maybe_fire_alert(svc, result)

                elif stype == "heartbeat_group":
                    if ran_any_leaf or now >= self._next_due.get(sid, 0):
                        interval = float(svc.get("poll_interval_seconds", 30))
                        self._next_due[sid] = now + interval
                        result = self._run_heartbeat_group(svc)
                        with self._lock:
                            self._results[sid] = result
                        self._maybe_fire_alert(svc, result)

            # Broadcast summary to connected tablets via Socket.IO
            if ran_any_leaf and self._on_summary_change:
                try:
                    self._on_summary_change(self.get_summary())
                except Exception as e:
                    self._logger.debug(f"Health summary broadcast failed: {e}")

            # Periodic log heartbeat
            heartbeat_counter += 1
            if heartbeat_counter >= 60:
                heartbeat_counter = 0
                self._logger.info(f"Health checker heartbeat: services={len(self._results)}")

            time.sleep(1)

    # -------------------------------------------------------------------------
    # CHECK IMPLEMENTATIONS
    # -------------------------------------------------------------------------

    def _run_check(self, svc: dict) -> ServiceResult:
        """Dispatch to the appropriate check type."""
        stype = svc.get("type", "")
        try:
            if stype == "http":
                return self._check_http(svc)
            elif stype == "http_json":
                return self._check_http_json(svc)
            elif stype == "tcp":
                return self._check_tcp(svc)
            elif stype == "process":
                return self._check_process(svc)
            elif stype == "process_and_tcp":
                return self._check_process_and_tcp(svc)
            elif stype == "obs_rpc":
                return self._check_obs_rpc(svc)
            elif stype == "ffprobe_rtsp":
                return self._check_ffprobe_rtsp(svc)
            else:
                return ServiceResult(
                    id=svc["id"], name=svc.get("name", svc["id"]),
                    status=_level_label("down"),
                    message=f"Unknown check type: {stype}",
                    checked_at=_now_iso(),
                )
        except Exception as e:
            return ServiceResult(
                id=svc["id"], name=svc.get("name", svc["id"]),
                status=_level_label("down"),
                message=f"Check error: {e}",
                checked_at=_now_iso(),
            )

    def _check_http(self, svc: dict) -> ServiceResult:
        """HTTP status code check."""
        sid = svc["id"]
        name = svc.get("name", sid)
        url = svc.get("url", "")
        timeout = float(svc.get("timeout_seconds", self._default_timeout))
        ok_codes = svc.get("ok_http_codes", [200])
        bearer = svc.get("bearer_token", "")
        basic = svc.get("basic_auth")
        verify_tls = svc.get("verify_tls", True)

        headers = {"X-Tablet-ID": self._client_id}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"

        auth = None
        if basic:
            auth = (basic.get("username", ""), basic.get("password", ""))

        start = time.time()
        try:
            resp = requests.get(url, headers=headers, auth=auth,
                                timeout=timeout, verify=verify_tls)
            latency_ms = round((time.time() - start) * 1000, 1)

            if resp.status_code in ok_codes:
                level = "healthy"
                msg = f"HTTP {resp.status_code} OK"
                if svc.get("warn_if_ms_gt") and latency_ms > float(svc["warn_if_ms_gt"]):
                    level = "warning"
                    msg = f"HTTP {resp.status_code} OK (slow: {latency_ms}ms)"
            else:
                level = "down"
                msg = f"HTTP {resp.status_code} (expected {ok_codes})"

            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label(level),
                message=msg,
                checked_at=_now_iso(),
                last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
                latency_ms=latency_ms,
            )
        except requests.Timeout:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"Timeout after {timeout}s",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )
        except Exception as e:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=str(e),
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )

    def _check_http_json(self, svc: dict) -> ServiceResult:
        """HTTP GET + JSON path check."""
        sid = svc["id"]
        name = svc.get("name", sid)
        url = svc.get("url", "")
        timeout = float(svc.get("timeout_seconds", self._default_timeout))
        ok_path = svc.get("ok_json_path", "")
        ok_value = svc.get("ok_json_value")
        bearer = svc.get("bearer_token", "")
        basic = svc.get("basic_auth")
        verify_tls = svc.get("verify_tls", True)

        headers = {"X-Tablet-ID": self._client_id}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"

        auth = None
        if basic:
            auth = (basic.get("username", ""), basic.get("password", ""))

        start = time.time()
        try:
            resp = requests.get(url, headers=headers, auth=auth,
                                timeout=timeout, verify=verify_tls)
            latency_ms = round((time.time() - start) * 1000, 1)

            # Try to parse JSON body regardless of HTTP status code,
            # since internal module endpoints return 503 with valid JSON
            # when they report unhealthy — we want the JSON path check
            # to be the authority, not the HTTP status code.
            try:
                data = resp.json()
            except Exception as e:
                # No JSON body — fall back to HTTP status check
                self._logger.debug(f"Health: {name} JSON parse failed, falling back to HTTP status: {e}")
                if resp.status_code != 200:
                    prev = self._results.get(sid)
                    return ServiceResult(
                        id=sid, name=name,
                        status=_level_label("down"),
                        message=f"HTTP {resp.status_code}",
                        checked_at=_now_iso(),
                        last_ok_at=prev.last_ok_at if prev else None,
                        latency_ms=latency_ms,
                    )
                data = {}

            # Check JSON path
            actual = self._resolve_json_path(data, ok_path)
            if ok_value is not None:
                ok = (actual == ok_value) or (str(actual) == str(ok_value))
            else:
                ok = bool(actual)

            level = "healthy" if ok else "down"
            msg = f"OK ({ok_path}={actual})" if ok else f"{ok_path}={actual} (expected {ok_value})"

            # Latency warning
            if ok and svc.get("warn_if_ms_gt") and latency_ms > float(svc["warn_if_ms_gt"]):
                level = "warning"
                msg = f"OK but slow ({latency_ms}ms > {svc['warn_if_ms_gt']}ms)"

            # Extract detail_json_paths
            details = {}
            for label, path in svc.get("detail_json_paths", {}).items():
                details[label] = self._resolve_json_path(data, path)

            # Extract detail_url_json_paths (fetch secondary URLs)
            for label, url_cfg in svc.get("detail_url_json_paths", {}).items():
                try:
                    detail_url = url_cfg.get("url", "")
                    detail_path = url_cfg.get("path", "")
                    detail_headers = {"X-Tablet-ID": self._client_id}
                    if bearer:
                        detail_headers["Authorization"] = f"Bearer {bearer}"
                    r2 = requests.get(detail_url, headers=detail_headers,
                                      timeout=timeout, verify=verify_tls)
                    if r2.status_code == 200:
                        details[label] = self._resolve_json_path(r2.json(), detail_path)
                    else:
                        details[label] = f"HTTP {r2.status_code}"
                except Exception as e2:
                    details[label] = f"Error: {e2}"

            # warn_if_detail_equals
            if ok and svc.get("warn_if_detail_equals"):
                for dk, dv in svc["warn_if_detail_equals"].items():
                    if str(details.get(dk, "")) == str(dv):
                        level = "warning"
                        msg = f"OK but {dk}={dv}"
                        break

            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label(level),
                message=msg,
                checked_at=_now_iso(),
                last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
                latency_ms=latency_ms,
                details=details if details else None,
            )
        except requests.Timeout:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"Timeout after {timeout}s",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )
        except Exception as e:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=str(e),
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )

    def _check_tcp(self, svc: dict) -> ServiceResult:
        """TCP port connectivity check."""
        sid = svc["id"]
        name = svc.get("name", sid)
        host = svc.get("tcp_host", "")
        port = int(svc.get("tcp_port", 0))
        timeout = float(svc.get("timeout_seconds", self._default_timeout))

        start = time.time()
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
            sock.close()
            latency_ms = round((time.time() - start) * 1000, 1)

            level = "healthy"
            msg = f"TCP {host}:{port} open"
            if svc.get("warn_if_ms_gt") and latency_ms > float(svc["warn_if_ms_gt"]):
                level = "warning"
                msg = f"TCP open (slow: {latency_ms}ms)"

            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label(level),
                message=msg,
                checked_at=_now_iso(),
                last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
                latency_ms=latency_ms,
            )
        except Exception as e:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"TCP {host}:{port} - {e}",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )

    def _check_process(self, svc: dict) -> ServiceResult:
        """Check if a process is running."""
        sid = svc["id"]
        name = svc.get("name", sid)
        proc_name = svc.get("process_name", "")
        proc_contains = svc.get("process_contains", "")

        found = False
        for proc in psutil.process_iter(["name", "cmdline"]):
            try:
                pname = proc.info.get("name", "")
                if proc_name and pname == proc_name:
                    found = True
                    break
                if proc_contains:
                    cmdline = " ".join(proc.info.get("cmdline") or [])
                    if proc_contains in pname or proc_contains in cmdline:
                        found = True
                        break
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        prev = self._results.get(sid)
        if found:
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("healthy"),
                message=f"Process running: {proc_name or proc_contains}",
                checked_at=_now_iso(),
                last_ok_at=_now_iso(),
            )
        else:
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"Process not found: {proc_name or proc_contains}",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )

    def _check_process_and_tcp(self, svc: dict) -> ServiceResult:
        """Hybrid: process running AND TCP port open."""
        proc_result = self._check_process(svc)
        if proc_result.status["level"] == "down":
            return proc_result

        tcp_result = self._check_tcp(svc)
        if tcp_result.status["level"] == "down":
            return tcp_result

        # Both OK
        prev = self._results.get(svc["id"])
        return ServiceResult(
            id=svc["id"], name=svc.get("name", svc["id"]),
            status=_level_label("healthy"),
            message=f"Process running + TCP open",
            checked_at=_now_iso(),
            last_ok_at=_now_iso(),
            latency_ms=tcp_result.latency_ms,
        )

    def _check_obs_rpc(self, svc: dict) -> ServiceResult:
        """OBS WebSocket bridge check (via Home Remote plugin HTTP endpoints)."""
        sid = svc["id"]
        name = svc.get("name", sid)
        base_url = svc.get("base_url", "").rstrip("/")
        timeout = float(svc.get("timeout_seconds", self._default_timeout))

        start = time.time()
        details = {}
        try:
            # GetVersion
            r = requests.get(f"{base_url}/call/GetVersion", timeout=timeout)
            latency_ms = round((time.time() - start) * 1000, 1)
            if r.status_code != 200:
                prev = self._results.get(sid)
                return ServiceResult(
                    id=sid, name=name,
                    status=_level_label("down"),
                    message=f"OBS bridge HTTP {r.status_code}",
                    checked_at=_now_iso(),
                    last_ok_at=prev.last_ok_at if prev else None,
                    latency_ms=latency_ms,
                )

            # GetCurrentProgramScene
            try:
                r2 = requests.get(f"{base_url}/call/GetCurrentProgramScene", timeout=timeout)
                if r2.status_code == 200:
                    d2 = r2.json()
                    scene_data = d2.get("requestResult", {}).get("responseData", {})
                    details["Program Scene"] = scene_data.get("currentProgramSceneName", "?")
            except Exception as e:
                self._logger.debug(f"Health: OBS scene query failed: {e}")

            # GetStreamStatus
            try:
                r3 = requests.get(f"{base_url}/call/GetStreamStatus", timeout=timeout)
                if r3.status_code == 200:
                    d3 = r3.json()
                    stream_data = d3.get("requestResult", {}).get("responseData", {})
                    details["Streaming"] = "Yes" if stream_data.get("outputActive") else "No"
            except Exception as e:
                self._logger.debug(f"Health: OBS stream status query failed: {e}")

            # GetRecordStatus
            try:
                r4 = requests.get(f"{base_url}/call/GetRecordStatus", timeout=timeout)
                if r4.status_code == 200:
                    d4 = r4.json()
                    rec_data = d4.get("requestResult", {}).get("responseData", {})
                    details["Recording"] = "Yes" if rec_data.get("outputActive") else "No"
            except Exception as e:
                self._logger.debug(f"Health: OBS recording status query failed: {e}")

            level = "healthy"
            msg = "OBS bridge connected"
            if svc.get("warn_if_ms_gt") and latency_ms > float(svc["warn_if_ms_gt"]):
                level = "warning"
                msg = f"OBS bridge connected (slow: {latency_ms}ms)"

            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label(level),
                message=msg,
                checked_at=_now_iso(),
                last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
                latency_ms=latency_ms,
                details=details if details else None,
            )
        except requests.Timeout:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"OBS bridge timeout ({timeout}s)",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )
        except Exception as e:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"OBS bridge error: {e}",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )

    def _check_rtsp_tcp_fallback(self, svc: dict) -> ServiceResult:
        """TCP socket fallback when ffprobe is not installed.

        Parses the RTSP/RTSPS URL to extract host:port, then attempts a
        TCP connection.  Reports 'healthy' if the port is open, 'down'
        otherwise.  This gives meaningful reachability data without
        requiring the ffmpeg package.
        """
        sid = svc["id"]
        name = svc.get("name", sid)
        url = svc.get("url", "")
        timeout = float(svc.get("timeout_seconds", 10))

        parsed = urlparse(url)
        host = parsed.hostname or ""
        port = parsed.port or (554 if parsed.scheme == "rtsp" else 443)

        start = time.time()
        try:
            sock = socket.create_connection((host, port), timeout=timeout)
            sock.close()
            latency_ms = round((time.time() - start) * 1000, 1)

            level = "healthy"
            msg = "Reachable (TCP, ffprobe unavailable)"
            if svc.get("warn_if_ms_gt") and latency_ms > float(svc["warn_if_ms_gt"]):
                level = "warning"
                msg = f"Reachable but slow ({latency_ms}ms, TCP fallback)"

            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label(level),
                message=msg,
                checked_at=_now_iso(),
                last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
                latency_ms=latency_ms,
                details={"mode": "tcp_fallback"},
            )
        except Exception as e:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"Unreachable: {e}",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
                latency_ms=round((time.time() - start) * 1000, 1),
            )

    def _check_ffprobe_rtsp(self, svc: dict) -> ServiceResult:
        """RTSP/RTSPS stream validation via ffprobe subprocess.

        Falls back to TCP socket connection test if ffprobe is not installed,
        so camera health still shows reachability without requiring ffmpeg.
        """
        sid = svc["id"]
        name = svc.get("name", sid)
        url = svc.get("url", "")
        timeout = float(svc.get("timeout_seconds", 10))
        rw_timeout = svc.get("rw_timeout_us", 3000000)
        ffprobe = svc.get("ffprobe_path", "ffprobe")

        # Check if ffprobe binary exists (cached after first call)
        if not hasattr(self, '_ffprobe_available'):
            import shutil
            self._ffprobe_available = shutil.which(ffprobe) is not None
            if not self._ffprobe_available:
                self._logger.warning(f"[health] ffprobe not found ('{ffprobe}'). "
                                     f"Camera checks will use TCP fallback.")

        if not self._ffprobe_available:
            return self._check_rtsp_tcp_fallback(svc)

        start = time.time()
        try:
            cmd = [
                ffprobe, "-v", "error",
                "-rw_timeout", str(rw_timeout),
                "-show_entries", "stream=codec_name,width,height,r_frame_rate",
                "-of", "json",
            ]
            # -rtsp_transport tcp only works with plain rtsp://, not rtsps://
            if not url.startswith("rtsps://"):
                cmd.insert(3, "-rtsp_transport")
                cmd.insert(4, "tcp")
            cmd.append(url)
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            latency_ms = round((time.time() - start) * 1000, 1)

            if proc.returncode != 0:
                prev = self._results.get(sid)
                err = proc.stderr.strip()[:200] if proc.stderr else "ffprobe failed"
                return ServiceResult(
                    id=sid, name=name,
                    status=_level_label("down"),
                    message=f"ffprobe error: {err}",
                    checked_at=_now_iso(),
                    last_ok_at=prev.last_ok_at if prev else None,
                    latency_ms=latency_ms,
                )

            import json
            data = json.loads(proc.stdout)
            streams = data.get("streams", [])
            details = {}
            if streams:
                s = streams[0]
                details["codec"] = s.get("codec_name", "?")
                details["width"] = s.get("width", "?")
                details["height"] = s.get("height", "?")
                details["fps"] = s.get("r_frame_rate", "?")

            level = "healthy"
            msg = "Stream active"
            if svc.get("warn_if_ms_gt") and latency_ms > float(svc["warn_if_ms_gt"]):
                level = "warning"
                msg = f"Stream active (slow: {latency_ms}ms)"

            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label(level),
                message=msg,
                checked_at=_now_iso(),
                last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
                latency_ms=latency_ms,
                details=details if details else None,
            )
        except subprocess.TimeoutExpired:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"ffprobe timeout ({timeout}s)",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
                latency_ms=round((time.time() - start) * 1000, 1),
            )
        except Exception as e:
            prev = self._results.get(sid)
            return ServiceResult(
                id=sid, name=name,
                status=_level_label("down"),
                message=f"ffprobe error: {e}",
                checked_at=_now_iso(),
                last_ok_at=prev.last_ok_at if prev else None,
            )

    # -------------------------------------------------------------------------
    # COMPOSITE / HEARTBEAT GROUP
    # -------------------------------------------------------------------------

    def _run_composite(self, svc: dict) -> ServiceResult:
        """Aggregate member service results into a parent status."""
        sid = svc["id"]
        name = svc.get("name", sid)
        members = svc.get("members", [])
        warn_ge = int(svc.get("warn_if_bad_ge", 1))
        down_ge = int(svc.get("down_if_bad_ge", 2))

        member_rows = []
        bad_count = 0

        with self._lock:
            for mid in members:
                result = self._results.get(mid)
                if result:
                    row = {
                        "id": mid,
                        "name": result.name,
                        "level": result.status.get("level", "down"),
                        "label": result.status.get("label", "Unknown"),
                        "message": result.message,
                        "latency_ms": result.latency_ms,
                        "checked_at": result.checked_at,
                        "last_ok_at": result.last_ok_at,
                        "details": result.details,
                    }
                else:
                    child_svc = self._svc_by_id.get(mid, {})
                    row = {
                        "id": mid,
                        "name": child_svc.get("name", mid),
                        "level": "down",
                        "label": "No data",
                        "message": "Not checked yet",
                    }

                if row["level"] in ("warning", "down"):
                    bad_count += 1
                member_rows.append(row)

        if bad_count >= down_ge:
            level = "down"
        elif bad_count >= warn_ge:
            level = "warning"
        else:
            level = "healthy"

        msg = f"{bad_count}/{len(members)} unhealthy"
        prev = self._results.get(sid)
        return ServiceResult(
            id=sid, name=name,
            status=_level_label(level),
            message=msg,
            checked_at=_now_iso(),
            last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
            details={"member_rows": member_rows},
        )

    def _run_heartbeat_group(self, svc: dict) -> ServiceResult:
        """Aggregate tablet heartbeats into a group status."""
        sid = svc["id"]
        name = svc.get("name", sid)
        expected = svc.get("expected", [])
        warn_after = float(svc.get("warn_after_seconds", 900))
        stale_after = float(svc.get("stale_after_seconds", 1800))
        warn_ge = int(svc.get("warn_if_bad_ge", 1))
        down_ge = int(svc.get("down_if_bad_ge", 2))

        now = time.time()
        member_rows = []
        bad_count = 0

        with self._lock:
            hb = dict(self._heartbeats)

        for tablet in expected:
            tid = tablet.get("id", "")
            tname = tablet.get("name", tid)
            last_seen = hb.get(tid)

            if last_seen is None:
                level = "down"
                label = "Never seen"
                msg = "No heartbeat received"
                age = None
            else:
                age = now - last_seen
                if age <= warn_after:
                    level = "healthy"
                    label = "Online"
                    msg = f"Last seen {round(age)}s ago"
                elif age <= stale_after:
                    level = "warning"
                    label = "Stale"
                    msg = f"Last seen {round(age)}s ago (>{warn_after}s)"
                else:
                    level = "down"
                    label = "Offline"
                    msg = f"Last seen {round(age)}s ago (>{stale_after}s)"

            if level in ("warning", "down"):
                bad_count += 1

            member_rows.append({
                "id": tid,
                "name": tname,
                "level": level,
                "label": label,
                "message": msg,
                "latency_ms": round(age, 1) if age is not None else None,
                "checked_at": _now_iso(),
                "last_ok_at": datetime.fromtimestamp(last_seen, timezone.utc).isoformat() if last_seen else None,
            })

        if bad_count >= down_ge:
            level = "down"
        elif bad_count >= warn_ge:
            level = "warning"
        else:
            level = "healthy"

        msg = f"{bad_count}/{len(expected)} offline/stale"
        prev = self._results.get(sid)
        return ServiceResult(
            id=sid, name=name,
            status=_level_label(level),
            message=msg,
            checked_at=_now_iso(),
            last_ok_at=_now_iso() if level == "healthy" else (prev.last_ok_at if prev else None),
            details={"member_rows": member_rows},
        )

    # -------------------------------------------------------------------------
    # ALERTING
    # -------------------------------------------------------------------------

    def _maybe_fire_alert(self, svc: dict, result: ServiceResult):
        """Debounced webhook alert to Home Assistant."""
        sid = svc["id"]
        alert_cfg = svc.get("alert", {})
        defaults = self._alerts_cfg.get("defaults", {})

        enabled = alert_cfg.get("enabled", defaults.get("enabled", True))
        if not enabled:
            return

        # Schedule-aware: suppress alerts when service is expected to be off
        if not self._is_in_schedule_window(svc):
            return

        webhook_url = self._alerts_cfg.get("ha_webhook_url", "")
        if not webhook_url:
            return

        level = result.status.get("level", "down")
        now = time.time()

        if sid not in self._alert_state:
            self._alert_state[sid] = {
                "bad_since": None,
                "last_alert_at": 0,
                "last_level": "healthy",
            }

        state = self._alert_state[sid]

        if level == "healthy":
            if state["bad_since"] is not None:
                # Recovery — could fire recovery webhook here
                state["bad_since"] = None
            state["last_level"] = "healthy"
            return

        # Service is unhealthy
        if state["bad_since"] is None:
            state["bad_since"] = now
            self._logger.info(f"Health transition {sid} -> {level}")

        bad_duration = now - state["bad_since"]

        warn_after = float(alert_cfg.get("warn_after_seconds",
                                         defaults.get("warn_after_seconds", 30)))
        down_after = float(alert_cfg.get("down_after_seconds",
                                         defaults.get("down_after_seconds", 60)))
        cooldown = float(alert_cfg.get("cooldown_seconds",
                                       defaults.get("cooldown_seconds", 300)))

        threshold = down_after if level == "down" else warn_after
        if bad_duration < threshold:
            return

        if (now - state["last_alert_at"]) < cooldown:
            return

        # Only re-alert if level escalated (warning → down), not on repeat
        if state["last_alert_at"] > 0 and level == state["last_level"]:
            return

        # Fire alert
        state["last_alert_at"] = now
        state["last_level"] = level

        payload = {
            "service_id": sid,
            "service_name": result.name,
            "level": level,
            "message": result.message,
            "checked_at": result.checked_at,
            "bad_for_seconds": round(bad_duration),
        }

        try:
            requests.post(webhook_url, json=payload, timeout=5)
            self._logger.info(f"Health ALERT sent: {sid} level={level} ({result.message})")
        except Exception as e:
            self._logger.warning(f"Health alert webhook failed for {sid}: {e}")

    # -------------------------------------------------------------------------
    # HELPERS
    # -------------------------------------------------------------------------

    @staticmethod
    def _resolve_json_path(data: Any, path: str) -> Any:
        """Navigate a dot-separated JSON path."""
        if not path:
            return data
        parts = path.split(".")
        current = data
        for part in parts:
            if isinstance(current, dict):
                current = current.get(part)
            elif isinstance(current, list):
                try:
                    current = current[int(part)]
                except (ValueError, IndexError):
                    return None
            else:
                return None
        return current

    @staticmethod
    def _tail_file(path: str, lines: int = 200) -> str:
        """Read the last N lines of a file."""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                all_lines = f.readlines()
            return "".join(all_lines[-lines:])
        except Exception as e:
            return f"Error reading {path}: {e}"

    def _fetch_log_from_url(self, svc: dict, lines: int = 200) -> str:
        """Fetch logs from a remote URL."""
        url = svc.get("log_url", "")
        template = svc.get("log_line_template", "")
        bearer = svc.get("bearer_token", "")
        timeout = float(svc.get("timeout_seconds", self._default_timeout))

        headers = {"X-Tablet-ID": self._client_id}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"

        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code != 200:
                return f"HTTP {resp.status_code} from log URL"

            ct = resp.headers.get("Content-Type", "")
            if "json" in ct:
                entries = resp.json()
                if isinstance(entries, list) and template:
                    formatted = []
                    for entry in entries[-lines:]:
                        try:
                            formatted.append(template.format(**entry))
                        except (KeyError, IndexError):
                            formatted.append(str(entry))
                    return "\n".join(formatted)
                return resp.text[-10000:]
            return resp.text[-10000:]
        except Exception as e:
            return f"Error fetching logs: {e}"

    def _ha_call_service(self, domain: str, service: str, service_data: dict = None) -> bool:
        """Call a Home Assistant service."""
        base_url = self._ha_cfg.get("base_url", "")
        token = self._ha_cfg.get("token", "")
        verify = self._ha_cfg.get("verify_tls", True)

        if not base_url or not token:
            self._logger.warning("Health: HA not configured for recovery")
            return False

        url = f"{base_url}/api/services/{domain}/{service}"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        try:
            resp = requests.post(url, headers=headers, json=service_data or {},
                                 timeout=10, verify=verify)
            return resp.status_code < 400
        except Exception as e:
            self._logger.warning(f"Health HA service call failed: {e}")
            return False

    # -------------------------------------------------------------------------
    # SCHEDULE-AWARE ALERTING
    # -------------------------------------------------------------------------

    _DAY_ABBREVS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}

    def _is_in_schedule_window(self, svc: dict) -> bool:
        """Check if the current time falls within this service's expected operating window.

        Returns True (should be running) if:
        - No schedule config (backward compatible — always considered 'in window')
        - Current time is within warmup_minutes of a calendar event or static window
        Returns False (expected to be off) otherwise.
        """
        schedule = svc.get("schedule")
        if not schedule:
            return True

        tz = ZoneInfo("America/Los_Angeles")
        now = datetime.now(tz)
        warmup = timedelta(minutes=int(schedule.get("warmup_minutes", 60)))

        # Check calendar events first
        calendar_url = schedule.get("calendar_url", "")
        if calendar_url:
            events = self._get_calendar_events(calendar_url, now)
            for ev in events:
                # Event window: (event_start - warmup) to event_end
                if (ev["start"] - warmup) <= now <= ev["end"]:
                    return True

        # Check static fallback windows
        for window in schedule.get("fallback_windows", []):
            win_days = [self._DAY_ABBREVS.get(d.lower()) for d in window.get("days", [])]
            if now.weekday() not in win_days:
                continue
            start_parts = window.get("start", "00:00").split(":")
            end_parts = window.get("end", "23:59").split(":")
            win_start = now.replace(hour=int(start_parts[0]), minute=int(start_parts[1]), second=0, microsecond=0)
            win_end = now.replace(hour=int(end_parts[0]), minute=int(end_parts[1]), second=0, microsecond=0)
            if (win_start - warmup) <= now <= win_end:
                return True

        return False

    def _get_calendar_events(self, url_template: str, now: datetime) -> List[dict]:
        """Fetch and cache calendar events. Returns list of {start, end} datetimes."""
        # Build URL for current month
        url = url_template.replace("{month}", str(now.month)).replace("{year}", str(now.year))

        # Return cached if fresh
        last_fetch = self._calendar_fetched_at.get(url, 0)
        if time.time() - last_fetch < self._calendar_fetch_interval and url in self._calendar_cache:
            return self._calendar_cache[url]

        # Fetch and parse
        try:
            resp = requests.get(url, timeout=10)
            if resp.status_code != 200:
                self._logger.debug(f"Calendar feed HTTP {resp.status_code}: {url}")
                return self._calendar_cache.get(url, [])

            events = self._parse_rss_calendar(resp.text, now.tzinfo)
            self._calendar_cache[url] = events
            self._calendar_fetched_at[url] = time.time()
            self._logger.info(f"Calendar feed refreshed: {len(events)} events this month")
            return events
        except Exception as e:
            self._logger.debug(f"Calendar feed fetch failed: {e}")
            return self._calendar_cache.get(url, [])

    @staticmethod
    def _parse_rss_calendar(xml_text: str, tz) -> List[dict]:
        """Parse a FaithConnector RSS calendar feed into event windows.

        Expected RSS 2.0 format with <item> elements containing:
        - <title>: Event name
        - <description>: May contain date/time info
        - <pubDate>: RFC 822 date (used as event date)

        Falls back gracefully if format differs.
        """
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

            # Parse pubDate (RFC 822: "Sun, 15 Mar 2026 08:00:00 -0800")
            event_dt = _parse_rfc822(pub_date_el.text.strip(), tz)
            if event_dt is None:
                continue

            # Try to extract duration from description, default to 3 hours
            duration_hours = 3
            desc = (desc_el.text or "") if desc_el is not None else ""

            # Look for end time hints in description (e.g., "8:00 AM - 11:00 AM")
            import re
            time_range = re.search(
                r'(\d{1,2}:\d{2}\s*[APap][Mm])\s*[-–]\s*(\d{1,2}:\d{2}\s*[APap][Mm])',
                desc
            )
            if time_range:
                try:
                    from datetime import datetime as _dt
                    end_time = _dt.strptime(time_range.group(2).strip(), "%I:%M %p").time()
                    event_end = event_dt.replace(hour=end_time.hour, minute=end_time.minute)
                    if event_end <= event_dt:
                        event_end += timedelta(hours=duration_hours)
                except ValueError:
                    event_end = event_dt + timedelta(hours=duration_hours)
            else:
                event_end = event_dt + timedelta(hours=duration_hours)

            events.append({"start": event_dt, "end": event_end})

        return events


def _parse_rfc822(date_str: str, fallback_tz) -> Optional[datetime]:
    """Parse RFC 822 date string to timezone-aware datetime."""
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.astimezone(fallback_tz)
    except Exception:
        pass
    # Fallback: try common patterns
    for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%d %b %Y %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S"):
        try:
            dt = datetime.strptime(date_str, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=fallback_tz)
            return dt.astimezone(fallback_tz)
        except ValueError:
            continue
    return None
