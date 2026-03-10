"""REST endpoint handlers for the STP Gateway."""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import shutil
import threading
import time
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Optional

import requests as http_requests
import yaml
from flask import Response, jsonify, request, send_file, send_from_directory

from auth import get_tablet_id, get_actor, check_permission, revoke_user_sessions
from macro_engine import (
    execute_macro, fetch_ha_button_states, fetch_all_ha_entities, step_summary,
)
from polling import MockBackend

logger = logging.getLogger("stp-gateway")


def register_api_routes(ctx):
    """Register all REST API endpoints on the Flask app."""
    app = ctx.app
    socketio = ctx.socketio
    db = ctx.db
    cfg = ctx.cfg
    mock_mode = ctx.mock_mode
    state_cache = ctx.state_cache
    watchdog = ctx.watchdog
    verbose = ctx.verbose_logging

    static_dir = ctx.static_dir
    permissions_data = ctx.permissions_data
    devices_data = ctx.devices_data
    settings_data = ctx.settings_data

    mw_cfg = cfg.get("middleware", {})
    config_path = ctx.config_path
    timeouts = cfg.get("timeouts", {})

    # ---- Static file serving ----

    @app.route("/")
    def serve_index():
        return send_from_directory(static_dir, "index.html")

    @app.route("/<path:filepath>")
    def serve_static(filepath):
        if filepath.startswith("api/"):
            return jsonify({"error": "Not found"}), 404
        full = os.path.join(static_dir, filepath)
        if os.path.isfile(full):
            return send_from_directory(static_dir, filepath)
        slug = filepath.strip("/").lower()
        if slug in ctx.known_location_slugs:
            return send_from_directory(static_dir, "index.html")
        return jsonify({"error": "Not found"}), 404

    # ---- Proxy helper (legacy middleware) ----

    def _proxy_request(service: str, path: str, method: str = "GET",
                       json_data: dict = None, timeout: float = 5,
                       tablet: str = None) -> tuple:
        svc = mw_cfg.get(service, {})
        base_url = svc.get("url", "")
        api_key = svc.get("api_key", "")
        svc_timeout = svc.get("timeout", timeout)

        if not base_url:
            return {"error": f"Service {service} not configured"}, 503

        url = f"{base_url}{path}"
        headers = {}
        if api_key:
            headers["X-API-Key"] = api_key

        if not tablet:
            try:
                tablet = get_tablet_id()
            except RuntimeError:
                tablet = "System"
        headers["X-Tablet-ID"] = tablet

        if verbose.is_set():
            logger.debug(f"[VERBOSE] proxy >> {method} {service}{path} "
                         f"body={json.dumps(json_data)[:200] if json_data else 'none'}")

        start = time.time()
        try:
            if method == "GET":
                resp = http_requests.get(url, headers=headers, timeout=svc_timeout)
            else:
                resp = http_requests.post(
                    url, headers=headers, json=json_data, timeout=svc_timeout
                )
            latency = (time.time() - start) * 1000
            result = resp.json()

            if verbose.is_set():
                logger.debug(f"[VERBOSE] proxy << {service}{path} "
                             f"status={resp.status_code} latency={latency:.0f}ms "
                             f"result={json.dumps(result)[:200]}")

            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          json.dumps(result)[:500], latency)

            return result, resp.status_code

        except http_requests.Timeout:
            logger.warning(f"proxy {service}{path} TIMEOUT after {svc_timeout}s")
            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          f"TIMEOUT after {svc_timeout}s", svc_timeout * 1000)
            return {"error": f"{service} timeout after {svc_timeout}s"}, 504
        except http_requests.ConnectionError:
            logger.warning(f"proxy {service}{path} CONNECTION ERROR")
            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          "CONNECTION_ERROR: unreachable", 0)
            return {"error": f"{service} unreachable"}, 503
        except Exception as e:
            logger.warning(f"proxy {service}{path} ERROR: {e}")
            db.log_action(tablet, f"{service}:{path}", service,
                          json.dumps(json_data) if json_data else "",
                          f"ERROR: {e}", 0)
            return {"error": str(e)}, 500

    # ---- Health & Config ----

    @app.route("/api/health")
    def api_health():
        poller_status = watchdog.status()
        any_stale = any(p.get("stale") for p in poller_status.values())
        any_open = any(
            p.get("circuit", {}).get("state") == "open"
            for p in poller_status.values()
        )
        db_ok = True
        try:
            db._get_conn().execute("SELECT 1")
        except Exception as e:
            logger.warning(f"DB connectivity check failed: {e}")
            db_ok = False

        healthy = db_ok and not any_open
        status_code = 200 if healthy else 503
        return jsonify({
            "healthy": healthy,
            "degraded": any_stale and not any_open,
            "service": "stp-gateway",
            "version": settings_data.get("app", {}).get("version", "1.0.0"),
            "mock_mode": mock_mode,
            "db_ok": db_ok,
            "pollers": poller_status,
        }), status_code

    @app.route("/api/readiness")
    def api_readiness():
        """Deployment readiness probe — returns 200 only when all modules are connected."""
        checks = {}
        all_ok = True

        # Database
        try:
            db._get_conn().execute("SELECT 1")
            checks["database"] = "ok"
        except Exception:
            checks["database"] = "fail"
            all_ok = False

        # Device modules (None in mock mode = ok)
        for name, mod in [("x32", ctx.x32), ("moip", ctx.moip), ("obs", ctx.obs)]:
            if mod is None:
                checks[name] = "mock" if mock_mode else "disabled"
            elif hasattr(mod, "get_status"):
                try:
                    status = mod.get_status()
                    ok = status.get("healthy", False) if isinstance(status, dict) else False
                    checks[name] = "ok" if ok else "degraded"
                    if not ok:
                        all_ok = False
                except Exception:
                    checks[name] = "fail"
                    all_ok = False
            else:
                checks[name] = "ok"

        # Health module
        if ctx.health is not None:
            checks["health_module"] = "ok" if ctx.health._running else "fail"
            if not ctx.health._running:
                all_ok = False
        else:
            checks["health_module"] = "mock" if mock_mode else "disabled"

        # Pollers
        poller_status = watchdog.status()
        any_stale = any(p.get("stale") for p in poller_status.values())
        checks["pollers"] = "degraded" if any_stale else "ok"

        status_code = 200 if all_ok else 503
        return jsonify({"ready": all_ok, "checks": checks}), status_code

    @app.route("/api/wifi-debug")
    def api_wifi_debug():
        """Per-tablet WiFi connection stats for debugging disconnects."""
        from socket_handlers import conn_stats
        return jsonify(conn_stats.get_summary()), 200

    @app.route("/api/healthdash/summary")
    def api_healthdash_summary():
        health = ctx.health
        if health is None:
            return jsonify({"counts": {"healthy": 0, "warning": 0, "down": 0}, "total": 0}), 200
        return jsonify(health.get_summary()), 200

    @app.route("/api/healthdash/status")
    def api_healthdash_status():
        health = ctx.health
        if health is None:
            return jsonify({"generated_at": "", "results": {}, "heartbeat": {}}), 200
        return jsonify({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "results": health.get_all_results(),
            "heartbeat": health.get_heartbeats(),
        }), 200

    @app.route("/api/healthdash/services")
    def api_healthdash_services():
        health = ctx.health
        if health is None:
            return jsonify({"services": []}), 200
        return jsonify({"services": health.get_services_for_ui()}), 200

    @app.route("/api/healthdash/heartbeat", methods=["POST"])
    def api_healthdash_heartbeat():
        health = ctx.health
        if health is None:
            return jsonify({"ok": True}), 200
        data = request.get_json(silent=True) or {}
        tablet_id = data.get("tablet_id", "")
        if tablet_id:
            health.record_heartbeat(tablet_id, data)
        return jsonify({"ok": True}), 200

    @app.route("/api/healthdash/logs/<service_id>")
    def api_healthdash_logs(service_id: str):
        health = ctx.health
        if health is None:
            return jsonify({"service_id": service_id, "name": "", "lines": 0, "log": "Health module not active"}), 200
        lines = request.args.get("lines", 200, type=int)
        return jsonify(health.get_service_logs(service_id, lines)), 200

    @app.route("/api/healthdash/recover/<service_id>", methods=["POST"])
    def api_healthdash_recover(service_id: str):
        health = ctx.health
        if health is None:
            return jsonify({"ok": False, "message": "Health module not active"}), 503
        tablet = get_tablet_id()
        result = health.trigger_recovery(service_id)
        db.log_action(tablet, "healthdash:recover", service_id, "",
                      result.get("message", ""), 0)
        status_code = 200 if result.get("ok") else 500
        return jsonify(result), status_code

    @app.route("/api/healthdash/check_now", methods=["POST"])
    def api_healthdash_check_now():
        health = ctx.health
        if health is None:
            return jsonify({"ok": True}), 200
        health.force_check_now()
        return jsonify({"ok": True}), 200

    # ---- Occupancy ----

    @app.route("/api/occupancy/data")
    def api_occupancy_data():
        occupancy = ctx.occupancy
        if occupancy is None:
            return jsonify({"error": "Occupancy module not available (mock mode)"}), 503
        data = occupancy.get_data()
        if not data:
            return jsonify({"error": "Data not loaded yet. Try refreshing."}), 503
        if "error" in data:
            return jsonify({"error": data["error"]}), 404
        return jsonify(data)

    @app.route("/api/occupancy/refresh", methods=["POST"])
    def api_occupancy_refresh():
        occupancy = ctx.occupancy
        if occupancy is None:
            return jsonify({"ok": True}), 200
        try:
            occupancy.refresh_data()
            return jsonify({"ok": True, "message": "Data refreshed successfully."})
        except Exception as e:
            return jsonify({"ok": False, "message": str(e)}), 500

    @app.route("/api/occupancy/config")
    def api_occupancy_config():
        occupancy = ctx.occupancy
        if occupancy is None:
            return jsonify({}), 200
        return jsonify(occupancy.get_config())

    @app.route("/api/config")
    def api_config():
        logger.info(f"[/api/config] devices_data keys={list(devices_data.keys())}, "
                     f"has moip={'moip' in devices_data}")
        obs_cfg = cfg.get("obs", {})
        safe_settings = {
            "app": settings_data.get("app", {}),
            "ptzCameras": {k: {"name": v.get("name", k), "ip": v.get("ip", "")} for k, v in cfg.get("ptz_cameras", {}).items()},
            "projectors": {k: {"displayName": v.get("name", k)} for k, v in cfg.get("projectors", {}).items()},
            "healthCheck": settings_data.get("healthCheck", {}),
            "obs": {"maxScenes": obs_cfg.get("max_scenes", 10)},
        }
        return jsonify({
            "settings": safe_settings,
            "devices": devices_data,
            "permissions": permissions_data,
        }), 200

    # ---- Settings ----

    @app.route("/api/settings/verbose-logging", methods=["GET"])
    def get_verbose_logging():
        return jsonify({"enabled": verbose.is_set()}), 200

    @app.route("/api/settings/verbose-logging", methods=["POST"])
    def set_verbose_logging():
        data = request.get_json(silent=True) or {}
        if bool(data.get("enabled", False)):
            verbose.set()
        else:
            verbose.clear()
        enabled = verbose.is_set()
        level_name = "DEBUG" if enabled else cfg.get("logging", {}).get("level", "INFO")
        logger.setLevel(getattr(logging, level_name))
        logger.info(f"Verbose logging {'ENABLED' if enabled else 'DISABLED'} by {get_tablet_id()}")
        db.log_action(get_tablet_id(), "settings:verbose_logging", "settings",
                      json.dumps({"enabled": enabled}), "OK", 0)
        return jsonify({"success": True, "enabled": enabled}), 200

    # ---- Config editor ----

    _EDITABLE_SCHEMA = {
        "gateway": ["host", "port", "debug"],
        "obs": ["ws_url", "ping_seconds", "snapshot_seconds",
                "offline_after_seconds", "ping_fails_to_offline", "max_scenes"],
        "moip": ["host_internal", "port_internal", "host_external", "port_external"],
        "x32": ["mixer_ip", "mixer_type", "ping_seconds", "snapshot_seconds",
                "offline_after_seconds", "ping_fails_to_offline"],
        "ptz_cameras": "*",
        "projectors": "*",
        "camlytics": ["communion_url", "communion_buffer_default",
                      "occupancy_url_peak", "occupancy_url_live",
                      "occupancy_buffer_default"],
        "security": ["allowed_ips", "session_timeout_minutes"],
        "fully_kiosk": ["devices"],
        "polling": ["moip", "x32", "obs", "projectors"],
        "timeouts": ["ptz_cameras", "projectors", "camlytics", "ha_proxy",
                     "ha_stream", "epson", "fully_kiosk", "occupancy_download"],
        "occupancy": ["data_dir", "building_subdir", "communion_subdir",
                      "service_hour_start", "service_hour_end",
                      "communion_window_start", "communion_window_end",
                      "occupancy_pacing_start", "occupancy_pacing_end",
                      "daily_reload_time", "download_days"],
        "anthropic": ["model", "max_tokens"],
    }

    _ENV_OVERRIDES = {
        "OBS_WS_PASSWORD": ("obs", "ws_password"),
        "MOIP_USERNAME": ("moip", "username"),
        "MOIP_PASSWORD": ("moip", "password"),
        "MOIP_HOST_INTERNAL": ("moip", "host_internal"),
        "MOIP_HOST_EXTERNAL": ("moip", "host_external"),
        "MOIP_HA_WEBHOOK_ID": ("moip", "ha_webhook_id"),
        "HA_URL": ("home_assistant", "url"),
        "HA_TOKEN": ("home_assistant", "token"),
        "WATTBOX_USERNAME": ("wattbox", "username"),
        "WATTBOX_PASSWORD": ("wattbox", "password"),
        "FLASK_SECRET_KEY": ("security", "secret_key"),
        "SETTINGS_PIN": ("security", "settings_pin"),
        "SECURE_PIN": ("security", "secure_pin"),
        "REMOTE_AUTH_USER": ("security", "remote_auth.username"),
        "REMOTE_AUTH_PASS": ("security", "remote_auth.password"),
        "FULLY_KIOSK_PASSWORD": ("fully_kiosk", "password"),
        "ANTHROPIC_API_KEY": ("anthropic", "api_key"),
        "HEALTHDASH_WEBHOOK_URL": ("healthdash", "alerts.ha_webhook_url"),
    }

    def _get_env_overridden_fields() -> set:
        overridden = set()
        for env_var, (section, field) in _ENV_OVERRIDES.items():
            if os.environ.get(env_var):
                overridden.add(f"{section}.{field}")
        return overridden

    @app.route("/api/config/editable")
    def api_config_editable():
        overridden = _get_env_overridden_fields()
        result = {}
        for section, fields in _EDITABLE_SCHEMA.items():
            section_data = cfg.get(section, {})
            if fields == "*":
                result[section] = {"_value": copy.deepcopy(section_data), "_fields": "*"}
            else:
                section_out = {}
                for field in fields:
                    section_out[field] = section_data.get(field)
                result[section] = {"_value": section_out, "_fields": fields}
            env_flags = {}
            if fields == "*":
                for key in section_data:
                    if f"{section}.{key}" in overridden:
                        env_flags[key] = True
            else:
                for field in fields:
                    if f"{section}.{field}" in overridden:
                        env_flags[field] = True
            if env_flags:
                result[section]["_env"] = env_flags
        return jsonify(result), 200

    @app.route("/api/config/save", methods=["POST"])
    def api_config_save():
        data = request.get_json(silent=True) or {}
        if not data:
            return jsonify({"success": False, "error": "No data provided"}), 400

        overridden = _get_env_overridden_fields()
        config_abs = os.path.abspath(config_path)

        try:
            with open(config_abs, "r") as f:
                disk_cfg = yaml.safe_load(f) or {}

            changes = []
            for section, payload in data.items():
                if section not in _EDITABLE_SCHEMA:
                    continue
                allowed = _EDITABLE_SCHEMA[section]
                disk_section = disk_cfg.setdefault(section, {})

                if allowed == "*":
                    if isinstance(payload, dict):
                        disk_cfg[section] = payload
                        cfg[section] = copy.deepcopy(payload)
                        changes.append(section)
                else:
                    if not isinstance(payload, dict):
                        continue
                    for field, value in payload.items():
                        if field not in allowed:
                            continue
                        if f"{section}.{field}" in overridden:
                            continue
                        old_val = disk_section.get(field)
                        if old_val != value:
                            disk_section[field] = value
                            cfg.setdefault(section, {})[field] = value
                            changes.append(f"{section}.{field}")

            if not changes:
                return jsonify({"success": True, "message": "No changes detected"}), 200

            backup_path = config_abs + ".bak"
            shutil.copy2(config_abs, backup_path)

            with open(config_abs, "w") as f:
                yaml.safe_dump(disk_cfg, f, default_flow_style=False,
                               sort_keys=False, allow_unicode=True)

            logger.info(f"Config saved by {get_tablet_id()}: {changes}")
            db.log_action(get_tablet_id(), "config:save", "config",
                          json.dumps(changes), "OK", 0)

            return jsonify({"success": True, "changes": changes}), 200

        except Exception as e:
            logger.error(f"Config save failed: {e}")
            return jsonify({"success": False, "error": str(e)}), 500

    @app.route("/api/gateway/restart", methods=["POST"])
    def api_gateway_restart():
        import eventlet
        tablet = get_tablet_id()
        logger.info(f"Gateway restart requested by {tablet}")
        db.log_action(tablet, "gateway:restart", "gateway", "", "OK", 0)

        socketio.emit("gateway:restarting", {
            "message": "Gateway is restarting...",
            "requested_by": tablet,
        })

        def _do_restart():
            time.sleep(2)
            logger.info("Requesting restart from build app ops API")
            try:
                resp = http_requests.post(
                    "http://127.0.0.1:20856/ops/api/services/tablets_gateway/restart",
                    timeout=30,
                )
                logger.info(f"Build app restart response: {resp.status_code}")
            except Exception as e:
                logger.error(f"Failed to contact build app for restart: {e}")
                logger.info("Falling back to sys.exit(0)")
                import sys
                sys.exit(0)

        eventlet.spawn(_do_restart)
        return jsonify({"success": True, "message": "Restarting..."}), 200

    # ---- MoIP ----

    @app.route("/api/moip/receivers")
    def moip_receivers():
        if mock_mode:
            return jsonify(MockBackend.MOIP_RECEIVERS), 200
        result, status = ctx.moip.get_receivers()
        return jsonify(result), status

    @app.route("/api/moip/health")
    def moip_health():
        if mock_mode:
            return jsonify({"healthy": True, "connected": True, "mode": "mock",
                            "last_command_seconds_ago": 0, "failure_streak": 0,
                            "failure_threshold": 50, "last_reboot_seconds_ago": None,
                            "reboot_cooldown_minutes": 15}), 200
        health_status = ctx.moip.get_status()
        return jsonify(health_status), (200 if health_status.get("healthy") else 503)

    @app.route("/api/moip/switch", methods=["POST"])
    def moip_switch():
        perm_err = check_permission(get_tablet_id(), "source", permissions_data)
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        tx = data.get("transmitter", "")
        rx = data.get("receiver", "")
        result, status = ctx.moip.switch(str(tx), str(rx))
        if status < 400:
            try:
                fresh, fresh_status = ctx.moip.get_receivers()
                if fresh_status < 400 and fresh:
                    state_cache.set("moip", fresh)
                    socketio.emit("state:moip", fresh, room="moip")
            except Exception as e:
                logger.debug(f"MoIP state refresh after command failed: {e}")
        return jsonify(result), status

    @app.route("/api/moip/ir", methods=["POST"])
    def moip_ir():
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        code = data.get("code", "")
        ir_codes = devices_data.get("moip", {}).get("irCodes", {})
        if code in ir_codes:
            code = ir_codes[code]
        else:
            logger.warning(f"IR code name '{code}' not found in devices.json irCodes")
        tx = data.get("tx", "")
        rx = data.get("rx", "")
        result, status = ctx.moip.send_ir(str(tx), str(rx), code)
        return jsonify(result), status

    @app.route("/api/moip/scene", methods=["POST"])
    def moip_scene():
        perm_err = check_permission(get_tablet_id(), "source", permissions_data)
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        scene = data.get("scene", "")
        result, status = ctx.moip.activate_scene(str(scene))
        if status < 400:
            socketio.emit("state:moip", {"event": "scene", "data": data}, room="moip")
        return jsonify(result), status

    @app.route("/api/moip/osd", methods=["POST"])
    def moip_osd():
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "mock": True}), 200
        text = data.get("text")
        clear = data.get("clear", False)
        result, status = ctx.moip.send_osd(text=text, clear=bool(clear))
        return jsonify(result), status

    @app.route("/api/moip/preview", methods=["POST"])
    def moip_preview():
        preview_cfg = cfg.get("moip", {}).get("preview", {})
        if not preview_cfg.get("enabled"):
            return jsonify({"error": "Preview not configured. Set moip.preview.enabled in config.yaml."}), 404

        data = request.get_json(silent=True) or {}
        tx = data.get("transmitter")
        if tx is None:
            return jsonify({"error": "Missing 'transmitter' field"}), 400

        preview_rx = str(preview_cfg["preview_receiver"])
        tablet = get_tablet_id()

        # Use gateway proxy URL so browsers don't hit cross-origin issues
        proxy_stream_url = "/api/moip/preview/stream"
        stream_type = preview_cfg.get("stream_type", "mjpeg")

        if mock_mode:
            return jsonify({
                "success": True, "mock": True,
                "stream_url": proxy_stream_url,
                "stream_type": stream_type,
                "switch_delay_ms": preview_cfg.get("switch_delay_ms", 1500),
            }), 200

        result, status = ctx.moip.switch(str(tx), preview_rx)
        if status >= 400:
            return jsonify(result), status

        tx_name = str(tx)
        for t in devices_data.get("moip", {}).get("transmitters", []):
            if str(t.get("id")) == str(tx):
                tx_name = t.get("name", tx_name)
                break

        db.log_action(tablet, "moip:preview", f"TX{tx}", tx_name, "OK", 0)

        return jsonify({
            "success": True,
            "stream_url": proxy_stream_url,
            "stream_type": stream_type,
            "switch_delay_ms": preview_cfg.get("switch_delay_ms", 1500),
            "transmitter": tx,
            "transmitter_name": tx_name,
        }), 200

    @app.route("/api/moip/preview/config")
    def moip_preview_config():
        preview_cfg = cfg.get("moip", {}).get("preview", {})
        return jsonify({
            "enabled": preview_cfg.get("enabled", False),
            "switch_delay_ms": preview_cfg.get("switch_delay_ms", 1500),
        }), 200

    @app.route("/api/moip/preview/stream")
    def moip_preview_stream():
        """Proxy the HLS/MJPEG stream from the HDMI encoder to avoid cross-origin issues.
        For HLS: proxies .m3u8 manifests (rewriting URLs to also go through proxy).
        For MJPEG: proxies the raw multipart stream.
        """
        preview_cfg = cfg.get("moip", {}).get("preview", {})
        if not preview_cfg.get("enabled"):
            return jsonify({"error": "Preview not enabled"}), 404

        stream_type = preview_cfg.get("stream_type", "mjpeg")
        # Allow ?url= override for sub-playlist proxying; default to configured stream_url
        stream_url = request.args.get("url", preview_cfg.get("stream_url", preview_cfg.get("mjpeg_url", "")))
        if not stream_url:
            return jsonify({"error": "No stream URL configured"}), 500
        # Validate that proxied URLs point to the configured encoder IP
        encoder_ip = preview_cfg.get("encoder_ip", "")
        if request.args.get("url") and encoder_ip and encoder_ip not in stream_url:
            return jsonify({"error": "Invalid stream URL"}), 403

        try:
            if stream_type == "hls":
                from urllib.parse import urljoin, quote
                # Proxy HLS manifest — rewrite URLs to go through our proxy
                upstream = http_requests.get(stream_url, timeout=5)
                upstream.raise_for_status()
                # Derive base URL of the encoder for relative references
                base_url = stream_url.rsplit("/", 1)[0] + "/"
                lines = []
                for line in upstream.text.splitlines():
                    if line and not line.startswith("#"):
                        abs_url = urljoin(base_url, line.strip())
                        if abs_url.endswith(".m3u8"):
                            # Sub-playlist — route back through this same endpoint
                            lines.append(f"/api/moip/preview/stream?url={quote(abs_url, safe='')}")
                        else:
                            # Segment (.ts) — route through segment endpoint
                            lines.append(f"/api/moip/preview/segment?url={quote(abs_url, safe='')}")
                    else:
                        lines.append(line)
                manifest = "\n".join(lines) + "\n"
                return Response(
                    manifest,
                    content_type="application/vnd.apple.mpegurl",
                    headers={"Cache-Control": "no-cache, no-store"},
                )
            else:
                # Legacy MJPEG proxy
                upstream = http_requests.get(stream_url, stream=True, timeout=5)
                content_type = upstream.headers.get("Content-Type", "multipart/x-mixed-replace; boundary=myboundary")
                return Response(
                    upstream.iter_content(chunk_size=4096),
                    content_type=content_type,
                )
        except Exception as e:
            log.warning("Preview stream proxy failed: %s", e)
            return jsonify({"error": "Failed to connect to encoder"}), 502

    @app.route("/api/moip/preview/segment")
    def moip_preview_segment():
        """Proxy an individual HLS .ts segment from the encoder."""
        seg_url = request.args.get("url", "")
        if not seg_url:
            return jsonify({"error": "Missing url parameter"}), 400
        # Only allow proxying to the configured encoder IP
        preview_cfg = cfg.get("moip", {}).get("preview", {})
        encoder_ip = preview_cfg.get("encoder_ip", "")
        if encoder_ip and encoder_ip not in seg_url:
            return jsonify({"error": "Invalid segment URL"}), 403
        try:
            upstream = http_requests.get(seg_url, stream=True, timeout=10)
            upstream.raise_for_status()
            content_type = upstream.headers.get("Content-Type", "video/mp2t")
            return Response(
                upstream.iter_content(chunk_size=8192),
                content_type=content_type,
            )
        except Exception as e:
            log.warning("Preview segment proxy failed: %s", e)
            return jsonify({"error": "Failed to fetch segment"}), 502

    # ---- X32 ----

    @app.route("/api/x32/status")
    def x32_status():
        if mock_mode:
            return jsonify(MockBackend.X32_STATUS), 200
        return jsonify(ctx.x32.get_status()), 200

    @app.route("/api/x32/health")
    def x32_health():
        if mock_mode:
            return jsonify({"healthy": True, "mixer_type": "X32", "mixer_ip": "mock",
                            "cur_scene": "0", "cur_scene_name": "Mock Scene",
                            "seconds_since_last_ok": 0, "error": ""}), 200
        health_status = ctx.x32.get_health()
        return jsonify(health_status), (200 if health_status.get("healthy") else 503)

    @app.route("/api/x32/scene/<int:num>")
    def x32_scene(num: int):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if mock_mode:
            return jsonify({"success": True, "scene": num, "mock": True}), 200
        result, status = ctx.x32.set_scene(num)
        if status < 400:
            socketio.emit("state:x32", {"event": "scene", "scene": num}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/mute/<int:ch>/<state>")
    def x32_mute(ch: int, state: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "channel": ch, "muted": state == "on", "mock": True}), 200
        result, status = ctx.x32.mute_channel(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "mute", "channel": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/aux/<int:ch>/mute/<state>")
    def x32_aux_mute(ch: int, state: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "aux": ch, "muted": state == "on", "mock": True}), 200
        result, status = ctx.x32.mute_aux(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "aux_mute", "aux": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/volume/<int:ch>/<direction>")
    def x32_volume(ch: int, direction: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if direction not in ("up", "down"):
            return jsonify({"error": "Direction must be 'up' or 'down'"}), 400
        if mock_mode:
            return jsonify({"success": True, "channel": ch, "direction": direction, "mock": True}), 200
        result, status = ctx.x32.volume_channel(ch, direction)
        if status < 400:
            socketio.emit("state:x32", {"event": "volume", "channel": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/volume/<int:ch>/set/<float:value>")
    @app.route("/api/x32/volume/<int:ch>/set/<int:value>")
    def x32_volume_set(ch: int, value):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        value = float(value)
        if mock_mode:
            return jsonify({"success": True, "channel": ch, "volume": value, "mock": True}), 200
        result, status = ctx.x32.set_volume_channel(ch, value)
        if status < 400:
            socketio.emit("state:x32", {"event": "volume_set", "channel": ch, "value": value}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/aux/<int:ch>/volume/set/<float:value>")
    @app.route("/api/x32/aux/<int:ch>/volume/set/<int:value>")
    def x32_aux_volume_set(ch: int, value):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        value = float(value)
        if mock_mode:
            return jsonify({"success": True, "aux": ch, "volume": value, "mock": True}), 200
        result, status = ctx.x32.set_volume_aux(ch, value)
        if status < 400:
            socketio.emit("state:x32", {"event": "aux_volume_set", "aux": ch, "value": value}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/bus/<int:ch>/mute/<state>")
    def x32_bus_mute(ch: int, state: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "bus": ch, "muted": state == "on", "mock": True}), 200
        result, status = ctx.x32.mute_bus(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "bus_mute", "bus": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/bus/<int:ch>/volume/<direction>")
    def x32_bus_volume(ch: int, direction: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if direction not in ("up", "down"):
            return jsonify({"error": "Direction must be 'up' or 'down'"}), 400
        if mock_mode:
            return jsonify({"success": True, "bus": ch, "direction": direction, "mock": True}), 200
        result, status = ctx.x32.volume_bus(ch, direction)
        if status < 400:
            socketio.emit("state:x32", {"event": "bus_volume", "bus": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/bus/<int:ch>/volume/set/<float:value>")
    @app.route("/api/x32/bus/<int:ch>/volume/set/<int:value>")
    def x32_bus_volume_set(ch: int, value):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        value = float(value)
        if mock_mode:
            return jsonify({"success": True, "bus": ch, "volume": value, "mock": True}), 200
        result, status = ctx.x32.set_volume_bus(ch, value)
        if status < 400:
            socketio.emit("state:x32", {"event": "bus_volume_set", "bus": ch, "value": value}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/dca/<int:ch>/mute/<state>")
    def x32_dca_mute(ch: int, state: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "dca": ch, "muted": state == "on", "mock": True}), 200
        result, status = ctx.x32.mute_dca(ch, state)
        if status < 400:
            socketio.emit("state:x32", {"event": "dca_mute", "dca": ch, "state": state}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/dca/<int:ch>/volume/<direction>")
    def x32_dca_volume(ch: int, direction: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if direction not in ("up", "down"):
            return jsonify({"error": "Direction must be 'up' or 'down'"}), 400
        if mock_mode:
            return jsonify({"success": True, "dca": ch, "direction": direction, "mock": True}), 200
        result, status = ctx.x32.volume_dca(ch, direction)
        if status < 400:
            socketio.emit("state:x32", {"event": "dca_volume", "dca": ch, "direction": direction}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/dca/<int:ch>/volume/set/<float:value>")
    @app.route("/api/x32/dca/<int:ch>/volume/set/<int:value>")
    def x32_dca_volume_set(ch: int, value):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        value = float(value)
        if mock_mode:
            return jsonify({"success": True, "dca": ch, "volume": value, "mock": True}), 200
        result, status = ctx.x32.set_volume_dca(ch, value)
        if status < 400:
            socketio.emit("state:x32", {"event": "dca_volume_set", "dca": ch, "value": value}, room="x32")
        return jsonify(result), status

    # ---- X32 Audio Routing ----

    @app.route("/api/x32/routing/config")
    def x32_routing_config():
        if mock_mode:
            return jsonify({"source_groups": [], "destinations": [], "presets": {}, "send_level": 0.75}), 200
        return jsonify(ctx.x32.get_routing_config()), 200

    @app.route("/api/x32/routing")
    def x32_routing_state():
        if mock_mode:
            return jsonify({"groups": [], "destinations": [], "matrix": {}, "presets": {}, "mock": True}), 200
        result, status = ctx.x32.get_routing_state()
        return jsonify(result), status

    @app.route("/api/x32/routing/group", methods=["POST"])
    def x32_routing_group():
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        data = request.get_json(silent=True) or {}
        group_name = data.get("group")
        bus = data.get("bus")
        enabled = data.get("enabled", True)
        level = data.get("level")
        if not group_name or bus is None:
            return jsonify({"error": "Required: group, bus"}), 400
        if mock_mode:
            return jsonify({"success": True, "group": group_name, "bus": bus, "enabled": enabled, "mock": True}), 200
        result, status = ctx.x32.set_group_routing(group_name, int(bus), bool(enabled), level)
        if status < 400:
            socketio.emit("state:x32", {"event": "routing_change", "group": group_name, "bus": bus, "enabled": enabled}, room="x32")
        return jsonify(result), status

    @app.route("/api/x32/routing/preset/<preset_name>", methods=["POST"])
    def x32_routing_preset(preset_name: str):
        perm_err = check_permission(get_tablet_id(), "main", permissions_data)
        if perm_err:
            return perm_err
        if mock_mode:
            return jsonify({"success": True, "preset": preset_name, "mock": True}), 200
        result, status = ctx.x32.apply_routing_preset(preset_name)
        if status < 400:
            socketio.emit("state:x32", {"event": "routing_preset", "preset": preset_name}, room="x32")
        return jsonify(result), status

    # ---- OBS ----

    @app.route("/api/obs/status")
    def obs_status():
        if mock_mode:
            return jsonify({
                "healthy": True,
                "data": {
                    "streaming": True,
                    "recording": False,
                    "current_scene": "MainChurch_Altar",
                    "scenes": ["MainChurch_Altar", "MainChurch_Rear", "Chapel_Rear"],
                },
            }), 200
        result, status_code = ctx.obs.get_status()
        return jsonify(result), status_code

    @app.route("/api/obs/call/<request_type>", methods=["POST"])
    def obs_call(request_type: str):
        perm_err = check_permission(get_tablet_id(), "stream", permissions_data)
        if perm_err:
            return perm_err
        payload = request.get_json(silent=True)
        if mock_mode:
            mock_map = {
                "GetVersion": MockBackend.OBS_VERSION,
                "GetStreamStatus": MockBackend.OBS_STREAM_STATUS,
                "GetCurrentProgramScene": MockBackend.OBS_SCENE,
            }
            return jsonify(mock_map.get(request_type, {"result": True, "mock": True})), 200
        result, err = ctx.obs.call(request_type, payload)
        if err:
            return jsonify({"result": False, "comment": err}), 503
        return jsonify({"result": True, "requestResult": result}), 200

    @app.route("/api/obs/emit/<request_type>", methods=["POST"])
    def obs_emit(request_type: str):
        perm_err = check_permission(get_tablet_id(), "stream", permissions_data)
        if perm_err:
            return perm_err
        payload = request.get_json(silent=True)
        if mock_mode:
            return jsonify({"result": True, "mock": True}), 200
        err = ctx.obs.emit(request_type, payload)
        if err:
            return jsonify({"result": False, "comment": err}), 503
        socketio.emit("state:obs", {"event": request_type, "data": payload}, room="obs")
        return jsonify({"result": True}), 200

    # ---- PTZ ----

    @app.route("/api/ptz/<camera_key>/command", methods=["POST"])
    def ptz_command(camera_key: str):
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(camera_key)
        if not cam:
            return jsonify({"error": f"Unknown camera: {camera_key}"}), 404
        data = request.get_json(silent=True) or {}
        command = data.get("command", "")
        if not command:
            return jsonify({"error": "Missing 'command' field"}), 400
        if mock_mode:
            return jsonify({"success": True, "camera": camera_key, "command": command, "mock": True}), 200
        url = f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&{command}"
        tablet = get_tablet_id()
        start = time.time()
        try:
            ptz_timeout = timeouts.get("ptz_cameras", 3)
            resp = http_requests.get(url, timeout=ptz_timeout)
            latency = (time.time() - start) * 1000
            success = resp.status_code == 200
            db.log_action(tablet, "ptz:command", camera_key, command,
                          f"status={resp.status_code}", latency)
            return jsonify({
                "success": success, "camera": camera_key, "command": command,
                "status_code": resp.status_code, "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            db.log_action(tablet, "ptz:command", camera_key, command, "timeout", timeouts.get("ptz_cameras", 3) * 1000)
            return jsonify({"error": "Camera timeout", "camera": camera_key}), 504
        except http_requests.ConnectionError:
            db.log_action(tablet, "ptz:command", camera_key, command, "unreachable", 0)
            return jsonify({"error": "Camera unreachable", "camera": camera_key}), 503

    @app.route("/api/ptz/<camera_key>/preset/<int:preset_num>", methods=["POST"])
    def ptz_preset(camera_key: str, preset_num: int):
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(camera_key)
        if not cam:
            return jsonify({"error": f"Unknown camera: {camera_key}"}), 404
        if mock_mode:
            return jsonify({"success": True, "camera": camera_key, "preset": preset_num, "mock": True}), 200
        url = f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&{preset_num}"
        tablet = get_tablet_id()
        start = time.time()
        try:
            resp = http_requests.get(url, timeout=timeouts.get("ptz_cameras", 3))
            latency = (time.time() - start) * 1000
            db.log_action(tablet, "ptz:preset", camera_key, str(preset_num),
                          f"status={resp.status_code}", latency)
            return jsonify({
                "success": resp.status_code == 200, "camera": camera_key,
                "preset": preset_num, "latency_ms": round(latency, 1),
            }), 200
        except Exception as e:
            return jsonify({"error": str(e), "camera": camera_key}), 503

    @app.route("/api/ptz/<camera_key>/snapshot")
    def ptz_snapshot(camera_key: str):
        cameras = cfg.get("ptz_cameras", {})
        cam = cameras.get(camera_key)
        if not cam:
            return jsonify({"error": f"Unknown camera: {camera_key}"}), 404
        if mock_mode:
            return send_file(BytesIO(b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01'
                                     b'\x00\x00\x01\x00\x01\x00\x00\xff\xd9'),
                             mimetype="image/jpeg")
        snapshot_path = cam.get("snapshot_path", "/snapshot.jpg")
        url = f"http://{cam['ip']}{snapshot_path}"
        try:
            resp = http_requests.get(url, timeout=timeouts.get("ptz_cameras", 3))
            if resp.status_code != 200:
                return "Camera returned non-200", 502
            ct = resp.headers.get("Content-Type", "image/jpeg")
            return Response(resp.content, content_type=ct,
                            headers={"Cache-Control": "no-store"})
        except http_requests.Timeout:
            return "Camera timeout", 504
        except http_requests.ConnectionError:
            return "Camera unreachable", 503

    # ---- Projectors ----

    @app.route("/api/projector/status")
    def projector_status():
        projectors = cfg.get("projectors", {})
        if mock_mode:
            return jsonify({
                k: {"name": v.get("name", k), "power": "on"}
                for k, v in projectors.items()
            }), 200
        statuses = {}
        for key, proj in projectors.items():
            try:
                resp = http_requests.get(
                    f"http://{proj['ip']}/api/v01/contentmgr/remote/power/",
                    timeout=timeouts.get("projectors", 5),
                )
                statuses[key] = {"name": proj.get("name", key), "power": "on" if resp.status_code == 200 else "unknown", "reachable": True}
            except Exception as e:
                logger.debug(f"Projector {key} status poll failed: {e}")
                statuses[key] = {"name": proj.get("name", key), "power": "unknown", "reachable": False}
        state_cache.set("projectors", statuses)
        return jsonify(statuses), 200

    @app.route("/api/projector/<projector_key>/power", methods=["POST"])
    def projector_power(projector_key: str):
        projectors = cfg.get("projectors", {})
        proj = projectors.get(projector_key)
        if not proj:
            return jsonify({"error": f"Unknown projector: {projector_key}"}), 404
        data = request.get_json(silent=True) or {}
        state = data.get("state", "")
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        if mock_mode:
            return jsonify({"success": True, "projector": projector_key, "state": state, "mock": True}), 200
        url = f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}"
        tablet = get_tablet_id()
        start = time.time()
        try:
            resp = http_requests.get(url, timeout=timeouts.get("projectors", 5))
            latency = (time.time() - start) * 1000
            db.log_action(tablet, "projector:power", projector_key, state,
                          f"status={resp.status_code}", latency)
            socketio.emit("state:projectors", {
                "event": "power", "projector": projector_key, "state": state
            }, room="projectors")
            return jsonify({
                "success": resp.status_code == 200, "projector": projector_key,
                "state": state, "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            return jsonify({"error": "Projector timeout", "projector": projector_key}), 504
        except http_requests.ConnectionError:
            return jsonify({"error": "Projector unreachable", "projector": projector_key}), 503

    @app.route("/api/projector/all/power", methods=["POST"])
    def projector_all_power():
        data = request.get_json(silent=True) or {}
        state = data.get("state", "")
        if state not in ("on", "off"):
            return jsonify({"error": "State must be 'on' or 'off'"}), 400
        projectors = cfg.get("projectors", {})
        results = {}
        for key, proj in projectors.items():
            if mock_mode:
                results[key] = {"success": True, "mock": True}
                continue
            url = f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}"
            try:
                resp = http_requests.get(url, timeout=timeouts.get("projectors", 5))
                results[key] = {"success": resp.status_code == 200}
            except Exception as e:
                results[key] = {"success": False, "error": str(e)}
        tablet = get_tablet_id()
        db.log_action(tablet, "projector:all_power", "all", state, json.dumps(results)[:500], 0)
        socketio.emit("state:projectors", {"event": "all_power", "state": state}, room="projectors")
        return jsonify(results), 200

    # ---- Fully Kiosk ----

    @app.route("/api/fully/screensaver", methods=["POST"])
    def fully_screensaver():
        fk = cfg.get("fully_kiosk", {})
        port = fk.get("port", 2323)
        password = fk.get("password", "")
        data = request.get_json(silent=True) or {}
        timeout_val = data.get("timeout")
        if timeout_val is None:
            return jsonify({"error": "Missing 'timeout' parameter"}), 400
        timeout_val = int(timeout_val)
        tablet = get_tablet_id()
        if mock_mode:
            return jsonify({"success": True, "tablet": tablet, "timeout": timeout_val, "mock": True}), 200
        base_url = f"http://127.0.0.1:{port}/?password={password}"
        start = time.time()
        try:
            fk_timeout = timeouts.get("fully_kiosk", 5)
            http_requests.get(
                f"{base_url}&cmd=setStringSetting&key=timeToScreensaverV2&value={timeout_val}",
                timeout=fk_timeout,
            )
            if timeout_val > fk.get("screensaver_default", 20):
                http_requests.get(f"{base_url}&cmd=stopScreensaver", timeout=fk_timeout)
            latency = (time.time() - start) * 1000
            db.log_action(tablet, "fully:screensaver", "127.0.0.1", str(timeout_val),
                          f"timeout={timeout_val}s", latency)
            logger.info(f"Fully Kiosk screensaver set to {timeout_val}s [{tablet}]")
            return jsonify({
                "success": True, "tablet": tablet, "timeout": timeout_val,
                "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            logger.warning(f"Fully Kiosk timeout [{tablet}]")
            return jsonify({"error": "Fully Kiosk timeout"}), 504
        except http_requests.ConnectionError:
            logger.warning(f"Fully Kiosk unreachable [{tablet}]")
            return jsonify({"error": "Fully Kiosk unreachable"}), 503

    # ---- WattBox ----

    @app.route("/api/wattbox/devices")
    def wattbox_devices():
        wb_cfg = cfg.get("wattbox", {})
        devices = wb_cfg.get("devices", {})
        if not devices:
            return jsonify({"error": "No WattBox devices configured"}), 404
        result = {}
        for key, dev in devices.items():
            entry = {"label": dev["label"], "ip": dev["ip"], "outlet": dev["outlet"], "state": None}
            if not mock_mode:
                try:
                    resp = http_requests.get(
                        f"http://{dev['ip']}/control.cgi?outlet={dev['outlet']}&command=status",
                        auth=(wb_cfg.get("username", "admin"), wb_cfg.get("password", "")),
                        timeout=wb_cfg.get("timeout", 5),
                    )
                    body = resp.text.strip().lower()
                    entry["state"] = "on" if "1" in body or "on" in body else "off"
                except Exception as e:
                    logger.debug(f"WattBox outlet {key} poll failed: {e}")
                    entry["state"] = "unknown"
            else:
                entry["state"] = "on"
            result[key] = entry
        return jsonify(result), 200

    @app.route("/api/wattbox/<device_key>/power", methods=["POST"])
    def wattbox_power(device_key: str):
        wb_cfg = cfg.get("wattbox", {})
        devices = wb_cfg.get("devices", {})
        dev = devices.get(device_key)
        if not dev:
            return jsonify({"error": f"Unknown device: {device_key}"}), 404
        data = request.get_json(silent=True) or {}
        action = data.get("action", "cycle")
        if action not in ("on", "off", "cycle"):
            return jsonify({"error": f"Invalid action: {action}"}), 400
        tablet = get_tablet_id()
        cmd_map = {"on": 3, "off": 4, "cycle": 1}
        command = cmd_map[action]
        if mock_mode:
            return jsonify({"success": True, "device": device_key, "action": action, "mock": True}), 200
        start = time.time()
        try:
            resp = http_requests.get(
                f"http://{dev['ip']}/control.cgi?outlet={dev['outlet']}&command={command}",
                auth=(wb_cfg.get("username", "admin"), wb_cfg.get("password", "")),
                timeout=wb_cfg.get("timeout", 5),
            )
            latency = (time.time() - start) * 1000
            db.log_action(tablet, f"wattbox:{action}", dev["ip"],
                          f"outlet={dev['outlet']} ({dev['label']})",
                          f"status={resp.status_code}", latency)
            logger.info(f"WattBox {action} -> {dev['label']} (outlet {dev['outlet']} @ {dev['ip']}) [{tablet}]")
            return jsonify({
                "success": resp.status_code == 200, "device": device_key,
                "action": action, "latency_ms": round(latency, 1),
            }), 200
        except http_requests.Timeout:
            logger.warning(f"WattBox timeout: {dev['ip']} [{tablet}]")
            return jsonify({"error": f"WattBox at {dev['ip']} timed out"}), 504
        except http_requests.ConnectionError:
            logger.warning(f"WattBox unreachable: {dev['ip']} [{tablet}]")
            return jsonify({"error": f"WattBox at {dev['ip']} unreachable"}), 503

    # ---- Home Assistant ----

    @app.route("/api/ha/states/<path:entity_id>")
    def ha_get_state(entity_id: str):
        ha_cfg = cfg.get("home_assistant", {})
        if mock_mode:
            return jsonify({"entity_id": entity_id, "state": "on", "mock": True}), 200
        url = f"{ha_cfg['url']}/api/states/{entity_id}"
        headers = {"Authorization": f"Bearer {ha_cfg['token']}", "Content-Type": "application/json"}
        try:
            resp = http_requests.get(url, headers=headers, timeout=ha_cfg.get("timeout", 10))
            return jsonify(resp.json()), resp.status_code
        except Exception as e:
            return jsonify({"error": str(e)}), 503

    @app.route("/api/ha/service/<domain>/<service>", methods=["POST"])
    def ha_call_service(domain: str, service: str):
        ha_cfg = cfg.get("home_assistant", {})
        data = request.get_json(silent=True) or {}
        if mock_mode:
            return jsonify({"success": True, "domain": domain, "service": service, "mock": True}), 200
        url = f"{ha_cfg['url']}/api/services/{domain}/{service}"
        headers = {"Authorization": f"Bearer {ha_cfg['token']}", "Content-Type": "application/json"}
        tablet = get_tablet_id()
        start = time.time()
        try:
            resp = http_requests.post(url, headers=headers, json=data,
                                      timeout=ha_cfg.get("timeout", 10))
            latency = (time.time() - start) * 1000
            db.log_action(tablet, f"ha:{domain}/{service}", "home_assistant",
                          json.dumps(data)[:500], f"status={resp.status_code}", latency)
            try:
                body = resp.json() if resp.content else {"success": True}
            except ValueError:
                body = {"success": resp.ok}
            return jsonify(body), resp.status_code
        except Exception as e:
            return jsonify({"error": str(e)}), 503

    # ---- TTS & Announcements ----
    # TTS generation via edge-tts, announcement presets/sequences, WiiM playback.
    # The announcement module (announcement_module.py) handles all logic.
    # Audio is cached in-memory and served without auth so WiiM can fetch it.

    ann = ctx.announcements

    @app.route("/api/tts/generate", methods=["POST"])
    def tts_generate():
        """Generate TTS audio via edge-tts, cache it, return a gateway-hosted URL."""
        if mock_mode:
            return jsonify({"url": "/api/tts/audio/mock.mp3", "mock": True}), 200
        data = request.get_json(silent=True) or {}
        message = data.get("message", "").strip()
        if not message:
            return jsonify({"error": "message is required"}), 400
        voice = data.get("voice", ann.default_voice if ann else "en-US-AndrewNeural")
        result = ann.generate_tts(message, voice)
        if "error" in result:
            return jsonify(result), 502
        return jsonify(result), 200

    @app.route("/api/tts/voices")
    def tts_voices():
        """Return the curated list of supported TTS voices."""
        from announcement_module import DEFAULT_VOICES
        return jsonify({"voices": DEFAULT_VOICES, "total": len(DEFAULT_VOICES)}), 200

    @app.route("/api/tts/audio/<filename>")
    def tts_serve_audio(filename):
        """Serve cached TTS audio file (no auth required so WiiM can fetch it)."""
        entry = ann.get_cached_audio(filename) if ann else None
        if not entry:
            return jsonify({"error": "TTS audio not found or expired"}), 404
        return Response(entry["bytes"], mimetype=entry.get("content_type", "audio/mpeg"),
                        headers={"Cache-Control": "no-cache"})

    # ---- Announcement API ----

    @app.route("/api/announcements/config")
    def announcements_config():
        """Return full announcement config (presets, sequences, voices, defaults)."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503
        return jsonify(ann.get_config_summary()), 200

    @app.route("/api/announcements/reload", methods=["POST"])
    def announcements_reload():
        """Reload announcements.yaml config."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503
        ann.reload_config()
        return jsonify({"success": True, "presets": len(ann.get_presets()),
                        "sequences": len(ann.get_sequences())}), 200

    @app.route("/api/announcements/preset/<preset_key>", methods=["POST"])
    def announcements_play_preset(preset_key):
        """Play a preset announcement."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503
        data = request.get_json(silent=True) or {}
        voice = data.get("voice")
        gateway_origin = request.host_url.rstrip("/")
        tablet = get_tablet_id()
        logger.info("[ANNOUNCE-API] preset=%s voice=%s origin=%s tablet=%s",
                    preset_key, voice or ann.default_voice, gateway_origin, tablet)

        result = ann.announce_preset(preset_key, voice, gateway_origin)
        status = 200 if result.get("success") else 400
        db.log_action(tablet, "announce:preset", preset_key,
                      json.dumps({"voice": voice or ann.default_voice,
                                  "origin": gateway_origin}),
                      "OK" if result.get("success") else result.get("error", "FAILED"), 0)
        return jsonify(result), status

    @app.route("/api/announcements/text", methods=["POST"])
    def announcements_play_text():
        """Play a custom text announcement."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503
        data = request.get_json(silent=True) or {}
        text = data.get("text", "").strip()
        if not text:
            return jsonify({"error": "text is required"}), 400
        voice = data.get("voice")
        gateway_origin = request.host_url.rstrip("/")
        tablet = get_tablet_id()
        logger.info("[ANNOUNCE-API] custom text='%s' voice=%s origin=%s tablet=%s",
                    text[:60], voice or ann.default_voice, gateway_origin, tablet)

        result = ann.announce_text(text, voice, gateway_origin)
        status = 200 if result.get("success") else 502
        db.log_action(tablet, "announce:text", text[:100],
                      json.dumps({"voice": voice or ann.default_voice,
                                  "origin": gateway_origin}),
                      "OK" if result.get("success") else result.get("error", "FAILED"), 0)
        return jsonify(result), status

    @app.route("/api/announcements/sequence/<sequence_key>", methods=["POST"])
    def announcements_play_sequence(sequence_key):
        """Start a multi-step announcement sequence (runs in background thread)."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503
        data = request.get_json(silent=True) or {}
        voice = data.get("voice")
        gateway_origin = request.host_url.rstrip("/")
        tablet = get_tablet_id()

        def _run():
            result = ann.run_sequence(sequence_key, voice, gateway_origin, tablet)
            db.log_action(tablet, "announce:sequence", sequence_key,
                          json.dumps({"voice": voice or ann.default_voice}),
                          "OK" if result.get("success") else result.get("error", "FAILED"), 0)

        import eventlet
        eventlet.spawn(_run)
        return jsonify({"success": True, "message": f"Sequence '{sequence_key}' started"}), 200

    @app.route("/api/announcements/sequence/<sequence_key>/cancel", methods=["POST"])
    def announcements_cancel_sequence(sequence_key):
        """Cancel a running announcement sequence."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503
        result = ann.cancel_sequence(sequence_key)
        return jsonify(result), 200 if result.get("success") else 404

    @app.route("/api/announcements/active")
    def announcements_active():
        """Return list of currently running sequences."""
        if not ann:
            return jsonify({"active": []}), 200
        return jsonify({"active": ann.get_active_sequences()}), 200

    @app.route("/api/announcements/upload", methods=["POST"])
    def announcements_upload_audio():
        """Upload an MP3/audio file, cache it, and optionally play it on WiiM."""
        if not ann:
            return jsonify({"error": "Announcement module not available"}), 503

        if "file" not in request.files:
            return jsonify({"error": "No file uploaded"}), 400
        file = request.files["file"]
        if not file.filename:
            return jsonify({"error": "No filename"}), 400

        audio_bytes = file.read()
        result = ann.cache_uploaded_audio(audio_bytes, file.filename)
        if "error" in result:
            return jsonify(result), 400

        # Auto-play if requested
        play = request.form.get("play", "false").lower() == "true"
        if play:
            ann.pre_announce()
            gateway_origin = request.host_url.rstrip("/")
            play_result = ann.play_on_wiim(gateway_origin + result["url"])
            if "error" in play_result:
                result["play_error"] = play_result["error"]
            else:
                result["played"] = True

        tablet = get_tablet_id()
        db.log_action(tablet, "announce:upload", file.filename,
                      json.dumps({"size": len(audio_bytes)}),
                      "OK", 0)
        return jsonify(result), 200

    @app.route("/api/ha/entities")
    def ha_entities():
        if mock_mode:
            return jsonify({"total": 0, "domains": {}, "mock": True}), 200
        domain_filter = request.args.get("domain", "").strip()
        search = request.args.get("q", "").strip().lower()
        summary_only = (not domain_filter and not search)
        try:
            all_entities, err = fetch_all_ha_entities(ctx)
            if err:
                return jsonify({"error": err}), 503
        except Exception as e:
            return jsonify({"error": str(e)}), 503
        domains = {}
        for entity in all_entities:
            eid = entity.get("entity_id", "")
            domain = eid.split(".")[0] if "." in eid else "unknown"
            attrs = entity.get("attributes", {})
            friendly = attrs.get("friendly_name", "")
            if domain_filter and domain != domain_filter:
                continue
            if search and search not in eid.lower() and search not in friendly.lower():
                continue
            if domain not in domains:
                domains[domain] = {"count": 0, "entities": []}
            domains[domain]["count"] += 1
            if not summary_only:
                domains[domain]["entities"].append({
                    "entity_id": eid, "state": entity.get("state", "unknown"),
                    "friendly_name": friendly, "device_class": attrs.get("device_class", ""),
                    "attributes": attrs, "last_changed": entity.get("last_changed", ""),
                })
        sorted_domains = {}
        for d in sorted(domains.keys()):
            if not summary_only:
                domains[d]["entities"].sort(key=lambda e: e["entity_id"])
            else:
                domains[d].pop("entities", None)
            sorted_domains[d] = domains[d]
        total = sum(d["count"] for d in sorted_domains.values())
        return jsonify({"total": total, "domains": sorted_domains, "summary": summary_only}), 200

    @app.route("/api/ha/entities/yaml")
    def ha_entities_yaml():
        if mock_mode:
            return "# Mock mode -- no HA entities available\n", 200, {"Content-Type": "text/yaml"}
        try:
            all_entities, err = fetch_all_ha_entities(ctx)
            if err:
                return f"# Error: {err}\n", 503, {"Content-Type": "text/yaml"}
        except Exception as e:
            return f"# Error: {e}\n", 503, {"Content-Type": "text/yaml"}
        domains = {}
        for entity in all_entities:
            eid = entity.get("entity_id", "")
            domain = eid.split(".")[0] if "." in eid else "unknown"
            attrs = entity.get("attributes", {})
            if domain not in domains:
                domains[domain] = []
            entry = {
                "entity_id": eid,
                "state": entity.get("state", "unknown"),
                "friendly_name": attrs.get("friendly_name", ""),
            }
            if attrs.get("device_class"):
                entry["device_class"] = attrs["device_class"]
            if attrs.get("unit_of_measurement"):
                entry["unit"] = attrs["unit_of_measurement"]
            if domain == "climate":
                for key in ("current_temperature", "temperature", "hvac_modes",
                            "hvac_action", "fan_mode", "preset_mode"):
                    if key in attrs:
                        entry[key] = attrs[key]
            elif domain == "sensor":
                if attrs.get("state_class"):
                    entry["state_class"] = attrs["state_class"]
            elif domain == "media_player":
                for key in ("media_title", "source", "volume_level"):
                    if key in attrs:
                        entry[key] = attrs[key]
            domains[domain].append(entry)
        for d in domains:
            domains[d].sort(key=lambda e: e["entity_id"])
        total = sum(len(v) for v in domains.values())
        lines = [
            f"# Home Assistant Entity Reference",
            f"# Generated: {datetime.now().isoformat(timespec='seconds')}",
            f"# Total: {total} entities across {len(domains)} domains",
            f"#",
            f'# Usage in macros.yaml button configs:',
            f'#   state:  {{ source: ha, entity: "switch.example", on_value: "on", on_style: "active" }}',
            f'#   badge:  {{ source: ha, entity: "sensor.example", format: "percent" }}',
            f'#   badge:  {{ source: ha, entity: "climate.example", attribute: "current_temperature", format: "temp" }}',
            f"",
        ]
        output = "\n".join(lines) + "\n" + yaml.dump(
            dict(sorted(domains.items())),
            default_flow_style=False, allow_unicode=True, sort_keys=False, width=120,
        )
        return output, 200, {
            "Content-Type": "text/yaml; charset=utf-8",
            "Content-Disposition": "inline; filename=ha_entities.yaml",
        }

    @app.route("/api/ha/cameras")
    def ha_cameras():
        if mock_mode:
            return jsonify({"cameras": []}), 200
        with ctx.ha_cache_lock:
            if not ctx.ha_device_cache["ready"]:
                return jsonify({"cameras": [], "warming": True}), 200
            return jsonify({"cameras": ctx.ha_device_cache["cameras"]}), 200

    @app.route("/api/ha/camera/<path:entity_id>/snapshot")
    def ha_camera_snapshot(entity_id: str):
        ha_cfg = cfg.get("home_assistant", {})
        if not entity_id.startswith("camera."):
            entity_id = f"camera.{entity_id}"
        if mock_mode:
            return send_file(BytesIO(b'\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01'
                                     b'\x00\x00\x01\x00\x01\x00\x00\xff\xd9'),
                             mimetype="image/jpeg")
        url = f"{ha_cfg['url']}/api/camera_proxy/{entity_id}"
        headers = {"Authorization": f"Bearer {ha_cfg['token']}"}
        try:
            resp = http_requests.get(url, headers=headers, timeout=timeouts.get("ha_proxy", 10))
            if resp.status_code != 200:
                return f"HA returned {resp.status_code}", resp.status_code
            ct = resp.headers.get("Content-Type", "image/jpeg")
            return Response(resp.content, content_type=ct,
                            headers={"Cache-Control": "no-store"})
        except http_requests.Timeout:
            return "HA camera timeout", 504
        except http_requests.ConnectionError:
            return "HA unreachable", 503

    @app.route("/api/ha/camera/<path:entity_id>/stream")
    def ha_camera_stream(entity_id: str):
        ha_cfg = cfg.get("home_assistant", {})
        if not entity_id.startswith("camera."):
            entity_id = f"camera.{entity_id}"
        if mock_mode:
            return "MJPEG not available in mock mode", 503
        url = f"{ha_cfg['url']}/api/camera_proxy_stream/{entity_id}"
        headers = {"Authorization": f"Bearer {ha_cfg['token']}"}
        try:
            resp = http_requests.get(url, headers=headers, timeout=timeouts.get("ha_stream", 30), stream=True)
            if resp.status_code != 200:
                return f"HA returned {resp.status_code}", resp.status_code
            ct = resp.headers.get("Content-Type", "multipart/x-mixed-replace")
            return Response(resp.iter_content(chunk_size=8192),
                            content_type=ct, headers={"Cache-Control": "no-store"})
        except http_requests.Timeout:
            return "HA stream timeout", 504
        except http_requests.ConnectionError:
            return "HA unreachable", 503

    @app.route("/api/ha/locks")
    def ha_locks():
        if mock_mode:
            return jsonify({"locks": []}), 200
        with ctx.ha_cache_lock:
            if not ctx.ha_device_cache["ready"]:
                return jsonify({"locks": [], "warming": True}), 200
            return jsonify({"locks": ctx.ha_device_cache["locks"]}), 200

    # ---- Audit ----

    @app.route("/api/audit/logs")
    def audit_logs():
        limit = request.args.get("limit", 100, type=int)
        return jsonify(db.get_recent_logs(limit)), 200

    @app.route("/api/audit/sessions")
    def audit_sessions():
        return jsonify(db.get_sessions()), 200

    @app.route("/api/audit/actors")
    def audit_actors():
        """Return distinct actor values for the audit log filter dropdown."""
        return jsonify({"actors": db.get_distinct_actors()}), 200

    # ---- Macros API ----

    macro_defs = ctx.macro_defs
    button_defs = ctx.button_defs

    @app.route("/api/macros")
    def api_macros():
        page = request.args.get("page", "")
        result = {
            "macros": {k: {"label": v.get("label", k), "icon": v.get("icon", ""),
                           "description": v.get("description", ""),
                           "confirm": v.get("confirm", ""),
                           "has_conditionals": any(s.get("conditional") for s in v.get("steps", [])),
                           "steps": len(v.get("steps", []))}
                       for k, v in macro_defs.items()},
        }
        if page:
            result["buttons"] = button_defs.get(page, [])
        else:
            result["buttons"] = button_defs
        return jsonify(result), 200

    @app.route("/api/macros/switches")
    def api_macros_switches():
        page = request.args.get("page", "")
        if not page:
            return jsonify({"error": "page parameter required"}), 400
        sections = button_defs.get(page, [])
        if not sections:
            return jsonify({"switches": []}), 200
        macro_keys = set()
        for section in sections:
            all_items = list(section.get("items", []))
            for tab in section.get("tabs", []):
                all_items.extend(tab.get("items", []))
            for item in all_items:
                action = item.get("action", {})
                if action.get("type") == "macro" and action.get("macro"):
                    macro_keys.add(action["macro"])
                toggle = item.get("toggle")
                if toggle:
                    for branch in ("on", "off"):
                        ba = (toggle.get(branch) or {}).get("action", {})
                        if ba.get("type") == "macro" and ba.get("macro"):
                            macro_keys.add(ba["macro"])
        switch_ids = set()
        visited = set()
        def _walk_macro(key, depth=0):
            if depth > 5 or key in visited:
                return
            visited.add(key)
            macro = macro_defs.get(key)
            if not macro:
                return
            for step_item in macro.get("steps", []):
                stype = step_item.get("type", "")
                if stype == "ha_service":
                    eid = (step_item.get("data") or {}).get("entity_id", "")
                    if eid.startswith("switch."):
                        switch_ids.add(eid)
                elif stype == "ha_check":
                    eid = step_item.get("entity", "")
                    if eid.startswith("switch."):
                        switch_ids.add(eid)
                elif stype == "macro":
                    child = step_item.get("macro", "")
                    if child:
                        _walk_macro(child, depth + 1)
                elif stype == "condition":
                    for branch_key in ("then", "else"):
                        for sub in step_item.get(branch_key, []):
                            if sub.get("type") == "ha_service":
                                eid = (sub.get("data") or {}).get("entity_id", "")
                                if eid.startswith("switch."):
                                    switch_ids.add(eid)
        for mk in macro_keys:
            _walk_macro(mk)
        for section in sections:
            for item in section.get("items", []):
                toggle = item.get("toggle")
                if toggle:
                    tst = toggle.get("state", {})
                    if tst.get("source") == "ha":
                        eid = tst.get("entity", "")
                        if eid.startswith("switch."):
                            switch_ids.add(eid)
        switch_ids = {s for s in switch_ids if "TODO" not in s.upper()}
        return jsonify({"switches": sorted(switch_ids)}), 200

    @app.route("/api/macro/execute", methods=["POST"])
    def api_macro_execute():
        data = request.get_json(silent=True) or {}
        macro_key = data.get("macro", "")
        skip_steps = set(data.get("skip_steps", []))
        tablet = get_tablet_id()
        if not macro_key or macro_key not in macro_defs:
            return jsonify({"success": False, "error": f"Unknown macro: {macro_key}"}), 404
        logger.info(f"[{tablet}] Macro execute: {macro_key}"
                     + (f" (skipping {len(skip_steps)} steps)" if skip_steps else ""))
        result = execute_macro(ctx, macro_key, tablet, skip_steps=skip_steps)
        status_code = 200 if result.get("success") else 500
        return jsonify(result), status_code

    @app.route("/api/macro/expand/<macro_key>")
    def api_macro_expand(macro_key: str):
        if macro_key not in macro_defs:
            return jsonify({"error": f"Unknown macro: {macro_key}"}), 404
        def _expand(key: str, depth: int = 0) -> dict:
            if depth > 5:
                return {"macro": key, "label": key, "steps": [], "error": "Max depth exceeded"}
            macro = macro_defs.get(key, {})
            label = macro.get("label", key)
            steps = macro.get("steps", [])
            expanded = []
            for i, step_item in enumerate(steps):
                step_type = step_item.get("type", "")
                step_label = step_item.get("message", "") or step_summary(step_item, macro_defs)
                entry = {"index": i, "type": step_type, "label": step_label}
                if step_item.get("conditional"):
                    entry["conditional"] = step_item["conditional"]
                if step_type == "macro":
                    child_key = step_item.get("macro", "")
                    child = _expand(child_key, depth + 1)
                    entry["children"] = child.get("steps", [])
                    entry["child_macro"] = child_key
                    entry["child_label"] = child.get("label", child_key)
                expanded.append(entry)
            return {"macro": key, "label": label, "steps": expanded}
        return jsonify(_expand(macro_key)), 200

    @app.route("/api/macro/state")
    def api_macro_state():
        ha_states = state_cache.get("ha") or {}
        return jsonify({
            "ha": ha_states,
            "obs": state_cache.get("obs"),
            "x32": state_cache.get("x32"),
            "projectors": state_cache.get("projectors"),
            "moip": state_cache.get("moip"),
            "camlytics": state_cache.get("camlytics"),
        }), 200

    # ---- Camlytics ----

    @app.route("/api/camlytics/state")
    def api_camlytics_state():
        return jsonify(state_cache.get("camlytics") or {}), 200

    @app.route("/api/camlytics/buffer", methods=["POST"])
    def api_camlytics_buffer():
        data = request.get_json(silent=True) or {}
        buf_type = data.get("type", "")
        buf_value = data.get("value")
        if buf_type not in ("communion", "occupancy", "enter") or buf_value is None:
            return jsonify({"error": "type and value required"}), 400
        try:
            buf_value = float(buf_value)
        except (ValueError, TypeError):
            return jsonify({"error": "value must be a number"}), 400
        with ctx.camlytics_lock:
            ctx.camlytics_buffers[buf_type] = buf_value
        tablet = get_tablet_id()
        logger.info(f"[{tablet}] Camlytics buffer update: {buf_type} = {buf_value}%")
        return jsonify({"success": True, "buffer": buf_type, "value": buf_value}), 200

    # ---- Schedules ----

    @app.route("/api/schedules")
    def api_schedules():
        return jsonify(db.get_schedules()), 200

    @app.route("/api/schedule", methods=["POST"])
    def api_schedule_create():
        data = request.get_json(silent=True) or {}
        name = data.get("name", "")
        macro_key = data.get("macro", "")
        days = data.get("days", "0,1,2,3,4,5,6")
        time_of_day = data.get("time", "08:00")
        if not name or not macro_key:
            return jsonify({"error": "name and macro are required"}), 400
        if macro_key not in macro_defs:
            return jsonify({"error": f"Unknown macro: {macro_key}"}), 404
        sched_id = db.create_schedule(name, macro_key, days, time_of_day)
        logger.info(f"Schedule created: {name} -> {macro_key} at {time_of_day} days={days}")
        return jsonify({"id": sched_id, "success": True}), 201

    @app.route("/api/schedule/<int:sched_id>", methods=["PUT"])
    def api_schedule_update(sched_id: int):
        data = request.get_json(silent=True) or {}
        update = {}
        if "name" in data:
            update["name"] = data["name"]
        if "macro" in data:
            if data["macro"] not in macro_defs:
                return jsonify({"error": f"Unknown macro: {data['macro']}"}), 404
            update["macro_key"] = data["macro"]
        if "days" in data:
            update["days"] = data["days"]
        if "time" in data:
            update["time_of_day"] = data["time"]
        if "enabled" in data:
            update["enabled"] = 1 if data["enabled"] else 0
        db.update_schedule(sched_id, **update)
        return jsonify({"success": True}), 200

    @app.route("/api/schedule/<int:sched_id>", methods=["DELETE"])
    def api_schedule_delete(sched_id: int):
        db.delete_schedule(sched_id)
        return jsonify({"success": True}), 200

    # ---- Chat ----

    def _build_chat_system_prompt() -> str:
        parts = []

        # ---- Identity & Tone ----
        parts.append(
            "You are the AV Help Assistant for St. Paul Coptic Orthodox Church. "
            "Volunteers use tablet-based controls to manage audio, video, streaming, "
            "projectors, cameras, and climate across several rooms in the church building. "
            "Answer questions clearly and concisely. Use simple, non-technical language. "
            "When giving directions, reference page names and button labels as they appear on screen. "
            "If you don't know the answer, say so and suggest asking the AV team lead."
        )

        # ---- Church Facility ----
        parts.append(
            "\n## Church Building & Rooms\n"
            "St. Paul Coptic Orthodox Church has these rooms/areas:\n"
            "- **Main Church** — the main sanctuary with 4 Epson projectors (Front Left, Front Right, Rear Left, Rear Right), "
            "motorized projection screens, portable TVs, a Cry Room with its own TV, and a PA system\n"
            "- **Chapel** — smaller worship space with portable TVs (powered by EcoFlow batteries), its own audio system, and A/C\n"
            "- **Social Hall** — large fellowship hall with a video wall (two 2x2 TV arrays — left wall and right wall), its own audio, and A/C\n"
            "- **Gym** — gymnasium with TVs for live stream viewing\n"
            "- **Conference Room** — meeting room with two TVs (left and right)\n"
            "- **Baptism Room** — has its own PTZ camera\n"
            "- **Sunday School Classrooms** — 7+ classrooms (Angels I Pre-K, Angels II Kinder, 1st/2nd, 3rd/4th, 5th/6th, 7th/8th, High School) each with a display\n"
            "- **A/V Room** — the central control room where the Live Stream PC, audio mixer, and MoIP video controller are located\n"
            "- **Lobby** — entrance area\n"
            "- **Offices** — administrative offices\n"
            "- **Hamal Room** and **Lounge** — additional spaces with displays"
        )

        # ---- Tablet Locations & Permissions ----
        parts.append(
            "\n## Tablets & Permissions\n"
            "Control tablets are placed in specific rooms. Each tablet only shows pages relevant to its location:\n"
            "- **Main Church Tablet** & **A/V Room Tablet** — full access to all pages\n"
            "- **Chapel Tablet** — Home, Chapel, Stream, Source, Settings\n"
            "- **Social Hall Tablet** — Home, Social Hall, Stream, Source, Settings\n"
            "- **Conference Room Tablet** — Home, Conference Room, Source, Settings\n"
            "- **Gym Tablet** — Home, Gym, Source, Settings\n"
            "- **Lobby Tablet** — Home, Source, Settings\n"
            "- **Office Tablet** — Home, Conference Room, Source, Security, Settings\n"
            "If a volunteer can't see a page, their tablet's role may not include it."
        )

        # ---- Pages (detailed) ----
        parts.append(
            "\n## Pages & What They Do\n"
            "- **HOME** — Dashboard with quick-access buttons for each room. Also has an 'Ask a Question' chat button.\n"
            "- **MAIN** (Main Church) — Video On/Off (projectors + screens + portable TVs), Audio On/Off, "
            "A/C thermostat, video source selection (Podium Left/Right, Announcements, LOGO, Live Stream, Apple TV, Google Streamer, Baptism Camera), "
            "and live people counting (occupancy + communion counts). Tap the occupancy or communion number to see detailed analytics. "
            "At the bottom is a link to **Advanced Settings** which opens a panel with Power, TV Controls, and Video Source tabs.\n"
            "- **CHAPEL** — Chapel TVs On/Off (powered by EcoFlow batteries), Audio On/Off, A/C thermostat, source routing. "
            "Also has an Advanced Settings link at the bottom.\n"
            "- **SOCIAL** (Social Hall) — Social Hall video wall On/Off, Audio On/Off, A/C, source routing. "
            "Has Advanced Settings at the bottom.\n"
            "- **GYM** — Gym TV On/Off, audio on/off, source routing (Live Stream, LOGO, Announcements, Apple TV).\n"
            "- **CONF RM** (Conference Room) — Left and right TV control, Video Conference On/Off, source routing.\n"
            "- **STREAM** — Live streaming controls: OBS scene switching (Main Church, Chapel, Social Hall, Other), "
            "Start/Stop Streaming, Start/Stop Recording, PTZ camera control with preset recall. "
            "Shows OBS connection status (green = connected, red = disconnected).\n"
            "- **SOURCE** — Advanced video matrix routing (MoIP). Route any video source to any display individually. "
            "Also has audio routing and Alexa announcement controls.\n"
            "- **SECURITY** — Camera feeds from security cameras, door lock/unlock controls (can unlock exterior doors for a timed period).\n"
            "- **SETTINGS** — Has tabs at the top:\n"
            "  - **Power**: Shows all power switches (WattBox outlets) for the current room. Each switch shows on/off state and can be toggled.\n"
            "  - **Audio**: X32 mixer scene selection, channel/bus/DCA mute controls and volume faders.\n"
            "  - **Thermostats**: A/C controls for rooms that have thermostats.\n"
            "  - **TVs**: IR remote controls for individual TVs and projectors (power toggle, HDMI input select). "
            "Also has projector-only on/off, portable TV on/off, and AppleTV restart buttons.\n"
            "  - **Schedule**: Scheduled automations (timed macros).\n"
            "  - **Logs**: Audit log of all actions taken on tablets.\n"
            "  - **Config**: Edit configuration settings (requires Secure PIN).\n"
            "  - **Admin**: Reload App button, version info, Admin-only entity find & replace tool.\n"
            "Settings requires a PIN to access. The Config tab requires a separate Secure PIN.\n"
            "- **HEALTH** — System health dashboard showing status of 30+ services (accessible from Settings or direct link).\n"
            "- **OCCUPANCY** — Weekly occupancy analytics with charts (accessible via 'View Weekly Analytics' button in the people counting panel on room pages)."
        )

        # ---- Advanced Settings on Room Pages ----
        parts.append(
            "\n## Advanced Settings (on Room Pages)\n"
            "Each room page (Main, Chapel, Social, Gym, etc.) has an 'Advanced Settings' link at the bottom that opens a slide-up panel with tabs:\n"
            "- **Power Tab** — Individual power control for each device used on that page (projectors, TVs, screens, audio components, etc.). "
            "Devices are listed alphabetically. Each shows its current on/off state and can be toggled.\n"
            "- **TV Controls Tab** — IR remote buttons for individual TVs and projectors (power on/off, switch HDMI input).\n"
            "- **Video Source Tab** — Route specific video sources to specific displays, one at a time.\n"
            "This is useful when a specific device needs individual attention (e.g., one projector won't turn on)."
        )

        # ---- Projectors (from config) ----
        proj_cfg = cfg.get("projectors", {})
        if proj_cfg:
            proj_lines = []
            for key, p in proj_cfg.items():
                name = p.get("name", key) if isinstance(p, dict) else key
                proj_lines.append(f"- {name}")
            parts.append("\n## Projectors (Main Church)\n"
                         "4 Epson projectors in the Main Church, controlled via the Video On/Off buttons or individually in Advanced Settings > TV Controls:\n"
                         + "\n".join(proj_lines))

        # ---- PTZ Cameras (from config) ----
        ptz_cfg = cfg.get("ptz_cameras", {})
        if ptz_cfg:
            cam_lines = []
            seen = set()
            for key, c in ptz_cfg.items():
                name = c.get("name", key) if isinstance(c, dict) else key
                if name not in seen:
                    cam_lines.append(f"- {name}")
                    seen.add(name)
            parts.append("\n## PTZ Cameras\n"
                         "Pan-tilt-zoom cameras controllable from the STREAM page. Select a camera and recall presets:\n"
                         + "\n".join(cam_lines))

        # ---- WattBox Power Devices (from config) ----
        wb_cfg = cfg.get("wattbox", {}).get("devices", {})
        if wb_cfg:
            wb_lines = []
            for key, w in wb_cfg.items():
                label = w.get("label", key) if isinstance(w, dict) else key
                wb_lines.append(f"- {label}")
            parts.append("\n## Power Devices (WattBox PDUs)\n"
                         "Rack-mounted power distribution units that control power to key equipment. "
                         "Visible in Settings > Power tab and in Advanced Settings > Power on room pages:\n"
                         + "\n".join(wb_lines))

        # ---- EcoFlow Batteries ----
        parts.append(
            "\n## EcoFlow Batteries\n"
            "Portable TVs in the Chapel and Main Church are powered by EcoFlow battery packs. "
            "Each battery has AC and DC power monitored by the Health dashboard. "
            "If a portable TV won't turn on, the EcoFlow battery may be depleted or switched off. "
            "Check Settings > Power or the Health page for EcoFlow status."
        )

        # ---- Audio System ----
        parts.append(
            "\n## Audio System (Behringer X32 Mixer)\n"
            "The church uses a Behringer X32 digital audio mixer for all sound:\n"
            "- The Audio On button turns on the mixer, shared amplifiers, wireless microphone receivers, and a subwoofer, then loads the default audio scene.\n"
            "- Audio Off shuts everything down.\n"
            "- The mixer takes about 40 seconds to boot up after power-on.\n"
            "- Audio scenes can be changed in Settings > Audio tab. Each scene configures all microphone levels and routing for a specific service type.\n"
            "- Individual channel mutes, bus mutes, and DCA mutes can be toggled in Settings > Audio.\n"
            "- If you hear no sound, check: (1) Is audio turned on? (2) Is the correct scene loaded? (3) Are any channels muted? "
            "(4) Check Settings > Audio for mute states."
        )

        # ---- Video Routing (MoIP) ----
        moip_data = devices_data.get("moip", {})
        tx_list = moip_data.get("transmitters", [])
        rx_list = moip_data.get("receivers", [])
        if tx_list:
            tx_lines = [f"- {d.get('name', 'TX' + str(d.get('id', '')))} (TX {d.get('id', '')})"
                        for d in tx_list if isinstance(d, dict) and d.get("name") != "SPARE"]
            parts.append("\n## Video Sources (MoIP Transmitters)\n"
                         "These are the video inputs that can be routed to any display:\n"
                         + "\n".join(tx_lines))
        if rx_list:
            # Group receivers by location
            locations = {}
            for d in rx_list:
                if not isinstance(d, dict):
                    continue
                loc = d.get("location", "Other")
                name = d.get("name", f"RX{d.get('id','')}")
                if name == "Spare":
                    continue
                locations.setdefault(loc, []).append(name)
            rx_parts = []
            for loc in sorted(locations.keys()):
                rx_parts.append(f"- **{loc}**: {', '.join(locations[loc])}")
            parts.append("\n## Displays (MoIP Receivers) by Location\n"
                         "These are the screens/displays that can receive any video source:\n"
                         + "\n".join(rx_parts))

        # ---- Macros ----
        macro_lines = []
        for key, m in macro_defs.items():
            label = m.get("label", key)
            desc = m.get("description", "")
            if desc:
                macro_lines.append(f"- {label}: {desc}")
        if macro_lines:
            parts.append("\n## Available Macros (buttons volunteers can press)\n"
                         "Macros are multi-step automations triggered by buttons on the tablet. "
                         "When pressed, the button shows a progress bar. If a step fails, it may be skipped (orange warning) or the macro may abort (red error).\n"
                         + "\n".join(macro_lines[:120]))

        # ---- Notification Center ----
        parts.append(
            "\n## Notification Center\n"
            "The bell icon in the top-right corner of every page shows macro results and warnings. "
            "A red badge appears when there are unread notifications. Tap the bell to see recent macro history. "
            "If a macro completes with issues (some steps skipped), an orange warning toast appears — tap it to see details in the notification center."
        )

        # ---- People Counting & Occupancy ----
        parts.append(
            "\n## People Counting & Occupancy\n"
            "The Main Church page shows live people counts:\n"
            "- **Occupancy** — estimated current number of people, from Camlytics cameras at the building entrances. "
            "Includes a buffer adjustment for accuracy. Tap the number for detailed analytics.\n"
            "- **Communion** — count of people who received communion, tracked by a dedicated camera. "
            "The communion window is typically 10:30 AM – 12:15 PM.\n"
            "- **Occupancy Dashboard** — accessible via 'View Weekly Analytics' in the occupancy panel. "
            "Shows weekly trends, communion trends, week-over-week comparison, and pacing drill-down charts.\n"
            "Data is downloaded daily from Camlytics cloud and processed locally."
        )

        # ---- Live Streaming ----
        parts.append(
            "\n## Live Streaming (OBS Studio)\n"
            "The STREAM page controls OBS Studio for live streaming:\n"
            "- **Scene Switching** — Switch between Main Church, Chapel, Social Hall, and Other camera scenes.\n"
            "- **Start/Stop Stream** — Begin or end the YouTube/Facebook live stream.\n"
            "- **Start/Stop Recording** — Record locally to the Live Stream PC.\n"
            "- **PTZ Camera Control** — Select a camera and recall saved presets (numbered positions) to aim the camera.\n"
            "- OBS connection status shows green (connected) or red (disconnected) at the top of the page.\n"
            "- If the stream is offline, check: (1) Is OBS connected (green indicator)? (2) Is the Live Stream PC on? "
            "(3) Check Settings > Power for the Live Stream PC switch. (4) The Live Stream PC may need to be physically restarted."
        )

        # ---- Security ----
        parts.append(
            "\n## Security Page\n"
            "- View live camera feeds from security cameras around the building.\n"
            "- Unlock/lock exterior doors. The 'Unlock Exterior Doors' button unlocks doors for a timed period (typically 3-5 hours), then they auto-lock.\n"
            "- Requires the Secure PIN to access."
        )

        # ---- Health Dashboard ----
        parts.append(
            "\n## Health Dashboard\n"
            "The Health page monitors 30+ services and devices:\n"
            "- **Core**: STP Gateway, X32 Audio, MoIP Video, OBS Streaming\n"
            "- **Automation Hubs**: Home Assistant, Insteon\n"
            "- **Power**: 9 WattBox PDUs, 8 EcoFlow battery monitors\n"
            "- **Projectors**: 4 Epson projectors\n"
            "- **Camlytics**: 4 people-counting cameras + cloud service\n"
            "- **Tablets**: heartbeat monitoring for all control tablets\n"
            "Each service shows green (healthy), yellow (warning), or red (down). "
            "Tap a service card for details. Some services have recovery actions (restart, reboot)."
        )

        # ---- Common Workflows ----
        parts.append(
            "\n## Common Workflows\n"
            "**Setting up for a Sunday service (Main Church):**\n"
            "1. Press 'Audio On' — turns on mixer, amps, loads audio scene (~60 seconds)\n"
            "2. Press 'Video On' — turns on projectors, lowers screens, powers on portable TVs (~60 seconds)\n"
            "3. Select video source (usually Left Podium or Announcements)\n"
            "4. Go to STREAM page → select Main Church scene → Start Stream\n\n"
            "**Setting up Chapel:**\n"
            "1. Press 'Audio On' on the Chapel page\n"
            "2. Press 'TVs On' (these run on EcoFlow batteries)\n"
            "3. Select video source\n\n"
            "**Setting up Social Hall:**\n"
            "1. Press 'Audio On' on the Social Hall page\n"
            "2. Press 'Video On' to turn on the video wall\n"
            "3. Select video source\n\n"
            "**Tearing down after service:**\n"
            "Press 'Audio Off' and 'Video Off' on the room page. This powers everything down and raises the screens.\n\n"
            "**Switching video source mid-service:**\n"
            "Tap the desired source button on the room page (e.g., 'Announcements', 'LOGO', 'Left Podium'). "
            "The switch happens in 1-2 seconds.\n\n"
            "**Controlling a single device that isn't responding:**\n"
            "Go to Advanced Settings (link at bottom of room page) → Power tab to check its power state, "
            "or TV Controls tab to send IR commands directly."
        )

        # ---- Troubleshooting ----
        parts.append(
            "\n## Troubleshooting\n"
            "- **Projector not turning on**: Try 'Video On' again. If only one projector is stuck, "
            "go to Advanced Settings > TV Controls and try the individual projector power button. "
            "Check Advanced Settings > Power tab to see if the outlet is on.\n"
            "- **No audio / can't hear anything**: Check 'Audio On' is pressed (button should be green). "
            "Go to Settings > Audio tab — check that the correct scene is loaded and no channels are muted. "
            "The mixer takes ~40 seconds to boot, so wait if it was just turned on.\n"
            "- **Video not showing on a screen**: Make sure the TV/projector is powered on (Advanced Settings > Power). "
            "Re-select the video source on the room page. For individual displays, use SOURCE page to route directly.\n"
            "- **Only one screen is blank**: Use SOURCE page to route video to that specific display. "
            "Check Advanced Settings > Power to see if that display's outlet is on.\n"
            "- **Portable TV not working**: Check the EcoFlow battery — it may need charging. "
            "Look at Settings > Power or Health page for EcoFlow status.\n"
            "- **Chapel TV not turning on**: The Chapel TVs are powered by EcoFlow batteries. "
            "Check if the battery is charged. Try Advanced Settings > TV Controls to send IR power command.\n"
            "- **Live stream is offline**: Go to STREAM page. Check if OBS shows 'Connected' (green). "
            "If disconnected, the Live Stream PC may be off — check Settings > Power for the Live Stream PC switch. "
            "If OBS is connected but stream isn't going, press 'Start Stream'.\n"
            "- **Camera not moving / PTZ not responding**: On STREAM page, make sure the correct camera is selected. "
            "Try a different preset. The camera may be offline — check Health page.\n"
            "- **Video source buttons not working**: Check that the MoIP controller is online (Health page). "
            "Try the SOURCE page for manual routing.\n"
            "- **Thermostat not responding**: Check the Home Assistant status on the Health page. "
            "The thermostat is controlled through Home Assistant.\n"
            "- **Button shows error or macro failed**: Check the notification center (bell icon) for details. "
            "Orange warnings mean some steps were skipped but the macro continued. Red errors mean the macro stopped.\n"
            "- **A button is stuck / app is unresponsive**: Go to Settings > Admin > Reload App. "
            "This refreshes the tablet without losing anything.\n"
            "- **Door won't unlock**: The Security page requires the Secure PIN. Make sure you have the correct PIN. "
            "Check if Home Assistant is online (Health page).\n"
            "- **No people count showing**: The Camlytics cameras or cloud service may be down. Check the Health page for camera status.\n"
            "- **Wrong audio scene**: Go to Settings > Audio tab and select the correct scene from the dropdown."
        )

        # ---- Tips ----
        parts.append(
            "\n## Tips\n"
            "- Macro buttons show a progress bar while running. Wait for them to finish before pressing other buttons.\n"
            "- The notification center (bell icon, top right) keeps a history of macro results so you can review what happened.\n"
            "- Each room page has a help icon (?) that explains what each button does on that specific page.\n"
            "- The Settings page requires a PIN. The Config tab requires a separate Secure PIN.\n"
            "- If you need to route video to a specific classroom or uncommon display, use the SOURCE page.\n"
            "- The system supports multiple rooms running simultaneously — turning off audio in one room doesn't affect others."
        )

        return "\n".join(parts)

    _chat_system_prompt = _build_chat_system_prompt()

    @app.route("/api/chat", methods=["POST"])
    def api_chat():
        data = request.get_json(silent=True) or {}
        message = data.get("message", "").strip()
        page = data.get("page", "")
        history = data.get("history", [])
        if not message:
            return jsonify({"error": "message required"}), 400
        api_key = cfg.get("anthropic", {}).get("api_key", "")
        if not api_key:
            return jsonify({"error": "Chatbot not configured. Ask an admin to add the API key."}), 503
        messages = []
        for h in history[-10:]:
            role = h.get("role", "")
            content = h.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})
        messages.append({"role": "user", "content": message})
        page_context = f"\nThe volunteer is currently on the '{page}' page." if page else ""
        tablet = get_tablet_id()
        start = time.time()
        try:
            resp = http_requests.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
                json={
                    "model": cfg.get("anthropic", {}).get("model", "claude-haiku-4-5-20251001"),
                    "max_tokens": cfg.get("anthropic", {}).get("max_tokens", 1024),
                    "system": _chat_system_prompt + page_context,
                    "messages": messages,
                },
                timeout=30,
            )
            latency = (time.time() - start) * 1000
            result = resp.json()
            if resp.status_code >= 400:
                error_msg = result.get("error", {}).get("message", "API error")
                logger.warning(f"Chat API error: {resp.status_code} {error_msg}")
                db.log_action(tablet, "chat:message", page, message[:200],
                              f"FAILED: {error_msg}", latency)
                return jsonify({"error": "Chat service error. Please try again."}), 502
            reply = result.get("content", [{}])[0].get("text",
                    "Sorry, I couldn't generate a response.")
            db.log_action(tablet, "chat:message", page, message[:200], "OK", latency)
            return jsonify({"response": reply}), 200
        except http_requests.Timeout:
            logger.warning("Chat API timeout")
            db.log_action(tablet, "chat:message", page, message[:200], "TIMEOUT", 30000)
            return jsonify({"error": "Chat service timed out. Please try again."}), 504
        except Exception as e:
            logger.warning(f"Chat API error: {e}")
            db.log_action(tablet, "chat:message", page, message[:200], f"ERROR: {e}", 0)
            return jsonify({"error": "Chat service unavailable. Please try again."}), 503

    # ---- Entity Find & Replace ----

    @app.route("/api/entities/switches")
    def api_entities_switches():
        """Return all unique switch entity IDs referenced in macros.yaml."""
        macros_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macros.yaml")
        try:
            with open(macros_path, "r") as f:
                content = f.read()
        except Exception as e:
            return jsonify({"error": f"Cannot read macros.yaml: {e}"}), 500
        import re
        pattern = re.compile(r'switch\.\w+')
        matches = sorted(set(pattern.findall(content)))
        return jsonify({"switches": matches, "total": len(matches)}), 200

    @app.route("/api/entities/search")
    def api_entities_search():
        """Search for entity ID occurrences in macros.yaml."""
        q = request.args.get("q", "").strip()
        if not q:
            return jsonify({"error": "q parameter required"}), 400
        macros_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macros.yaml")
        try:
            with open(macros_path, "r") as f:
                lines = f.readlines()
        except Exception as e:
            return jsonify({"error": f"Cannot read macros.yaml: {e}"}), 500
        matches = []
        for i, line in enumerate(lines, 1):
            if q in line:
                matches.append({"line": i, "text": line.rstrip()})
        return jsonify({"query": q, "matches": matches, "total": len(matches)}), 200

    @app.route("/api/entities/replace", methods=["POST"])
    def api_entities_replace():
        """Replace entity IDs in macros.yaml (text-level, preserves formatting)."""
        data = request.get_json(silent=True) or {}
        tablet = get_tablet_id()
        replacements = data.get("replacements", [])
        # Each replacement: {old: "old_entity", new: "new_entity"}
        if not replacements:
            return jsonify({"error": "replacements list required"}), 400
        # Validate: no empty strings, old != new
        for r in replacements:
            old, new = r.get("old", "").strip(), r.get("new", "").strip()
            if not old or not new:
                return jsonify({"error": f"Invalid replacement: old and new required"}), 400
            if old == new:
                return jsonify({"error": f"old and new are identical: {old}"}), 400
        macros_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macros.yaml")
        try:
            with open(macros_path, "r") as f:
                content = f.read()
        except Exception as e:
            return jsonify({"error": f"Cannot read macros.yaml: {e}"}), 500
        # Create timestamped backup
        backup_path = macros_path + f".backup.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        try:
            shutil.copy2(macros_path, backup_path)
        except Exception as e:
            return jsonify({"error": f"Backup failed: {e}"}), 500
        # Apply replacements
        results = []
        for r in replacements:
            old, new = r["old"].strip(), r["new"].strip()
            count = content.count(old)
            if count > 0:
                content = content.replace(old, new)
                results.append({"old": old, "new": new, "count": count})
            else:
                results.append({"old": old, "new": new, "count": 0, "warning": "not found"})
        total_replaced = sum(r["count"] for r in results)
        if total_replaced == 0:
            # Remove backup since no changes
            try:
                os.remove(backup_path)
            except Exception:
                pass
            return jsonify({"success": True, "results": results, "total_replaced": 0,
                            "message": "No occurrences found — no changes made"}), 200
        # Write updated file
        try:
            with open(macros_path, "w") as f:
                f.write(content)
        except Exception as e:
            # Restore from backup
            try:
                shutil.copy2(backup_path, macros_path)
            except Exception:
                pass
            return jsonify({"error": f"Write failed: {e}"}), 500
        # Reload macros in memory
        from macro_engine import load_macros
        try:
            macros_cfg, new_macro_defs, new_button_defs, new_ha_entities = load_macros(cfg, logger)
            ctx.macros_cfg = macros_cfg
            ctx.macro_defs = new_macro_defs
            ctx.button_defs = new_button_defs
            ctx.ha_state_entities = new_ha_entities
        except Exception as e:
            logger.warning(f"Macro reload after entity replace failed: {e}")
        db.log_action(tablet, "entities:replace", f"{len(replacements)} replacement(s)",
                      json.dumps(results)[:500], f"OK, {total_replaced} occurrence(s) replaced", 0)
        logger.info(f"[{tablet}] Entity replace: {total_replaced} occurrence(s) across "
                    f"{len(replacements)} replacement(s), backup={backup_path}")
        return jsonify({
            "success": True,
            "results": results,
            "total_replaced": total_replaced,
            "backup": os.path.basename(backup_path),
        }), 200

    # ---- User management API ----

    user_module = ctx.user_module

    @app.route("/api/users", methods=["GET"])
    def api_users_list():
        """List all users (without password hashes). Requires secure PIN session."""
        if not user_module:
            return jsonify({"error": "User module not available"}), 503
        users = user_module.list_users()
        return jsonify({"users": users})

    @app.route("/api/users", methods=["POST"])
    def api_users_create():
        """Create a new user account."""
        if not user_module:
            return jsonify({"error": "User module not available"}), 503
        data = request.get_json(silent=True) or {}
        username = data.get("username", "")
        display_name = data.get("display_name", "")
        password = data.get("password", "")
        role = data.get("role", "full_access")

        # Validate role exists
        if role not in permissions_data.get("roles", {}):
            return jsonify({"error": f"Unknown role: {role}"}), 400

        try:
            user = user_module.create_user(username, display_name, password, role)
            actor = get_actor()
            db.log_action(get_tablet_id(), "user:create", username,
                          json.dumps({"role": role}), "OK", 0, actor=actor)
            return jsonify({"success": True, "user": user}), 201
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/api/users/<username>", methods=["PUT"])
    def api_users_update(username):
        """Update user fields (display_name, role, enabled)."""
        if not user_module:
            return jsonify({"error": "User module not available"}), 503
        data = request.get_json(silent=True) or {}
        fields = {}
        if "display_name" in data:
            fields["display_name"] = data["display_name"]
        if "role" in data:
            if data["role"] not in permissions_data.get("roles", {}):
                return jsonify({"error": f"Unknown role: {data['role']}"}), 400
            fields["role"] = data["role"]
        if "enabled" in data:
            fields["enabled"] = bool(data["enabled"])

        if not fields:
            return jsonify({"error": "No fields to update"}), 400

        try:
            user = user_module.update_user(username, **fields)
            # Invalidate active sessions if user was disabled
            if fields.get("enabled") is False:
                revoke_user_sessions(username)
            actor = get_actor()
            db.log_action(get_tablet_id(), "user:update", username,
                          json.dumps(fields), "OK", 0, actor=actor)
            return jsonify({"success": True, "user": user})
        except ValueError as e:
            return jsonify({"error": str(e)}), 404

    @app.route("/api/users/<username>", methods=["DELETE"])
    def api_users_delete(username):
        """Delete a user account."""
        if not user_module:
            return jsonify({"error": "User module not available"}), 503
        try:
            user_module.delete_user(username)
            revoke_user_sessions(username)
            actor = get_actor()
            db.log_action(get_tablet_id(), "user:delete", username, "", "OK", 0, actor=actor)
            return jsonify({"success": True})
        except ValueError as e:
            return jsonify({"error": str(e)}), 404

    @app.route("/api/users/<username>/reset-password", methods=["POST"])
    def api_users_reset_password(username):
        """Reset a user's password."""
        if not user_module:
            return jsonify({"error": "User module not available"}), 503
        data = request.get_json(silent=True) or {}
        new_password = data.get("password", "")
        try:
            user_module.reset_password(username, new_password)
            actor = get_actor()
            db.log_action(get_tablet_id(), "user:reset_password", username,
                          "", "OK", 0, actor=actor)
            return jsonify({"success": True})
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/api/users/me/password", methods=["POST"])
    def api_users_change_own_password():
        """Allow a logged-in user to change their own password."""
        from flask import session as flask_session
        if not user_module:
            return jsonify({"error": "User module not available"}), 503
        username = flask_session.get("user")
        if not username:
            return jsonify({"error": "Not logged in as a user"}), 403
        data = request.get_json(silent=True) or {}
        current_password = data.get("current_password", "")
        new_password = data.get("new_password", "")
        # Verify current password
        if not user_module.authenticate(username, current_password):
            return jsonify({"error": "Current password is incorrect"}), 401
        try:
            user_module.reset_password(username, new_password)
            actor = get_actor()
            db.log_action(get_tablet_id(), "user:change_password", username,
                          "", "OK", 0, actor=actor)
            return jsonify({"success": True})
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    @app.route("/api/users/roles", methods=["GET"])
    def api_users_roles():
        """List available roles from permissions.json for the user management UI."""
        roles = permissions_data.get("roles", {})
        result = []
        for key, info in roles.items():
            result.append({
                "key": key,
                "displayName": info.get("displayName", key),
            })
        return jsonify({"roles": result})

    # ---- Role management API ----

    # All available page keys for permission toggles
    _ALL_PAGES = ["home", "main", "chapel", "social", "gym", "confroom",
                  "stream", "source", "security", "settings"]

    def _save_permissions():
        """Persist permissions_data to permissions.json on disk."""
        perms_path = ctx.permissions_path
        if not perms_path:
            raise RuntimeError("permissions_path not set")
        with open(perms_path, "w") as f:
            json.dump(permissions_data, f, indent=2)
            f.write("\n")

    @app.route("/api/roles", methods=["GET"])
    def api_roles_list():
        """List all roles with full permission details."""
        roles = permissions_data.get("roles", {})
        result = []
        for key, info in roles.items():
            result.append({
                "key": key,
                "displayName": info.get("displayName", key),
                "permissions": info.get("permissions", {}),
            })
        return jsonify({"roles": result, "pages": _ALL_PAGES})

    @app.route("/api/roles", methods=["POST"])
    def api_roles_create():
        """Create a new role."""
        data = request.get_json(silent=True) or {}
        key = (data.get("key") or "").strip().lower().replace(" ", "_")
        display_name = (data.get("displayName") or "").strip()
        perms = data.get("permissions", {})

        if not key:
            return jsonify({"error": "Role key is required"}), 400
        if len(key) < 2 or len(key) > 32:
            return jsonify({"error": "Role key must be 2-32 characters"}), 400
        if not key.replace("_", "").isalnum():
            return jsonify({"error": "Role key may only contain letters, numbers, and underscores"}), 400
        if key in permissions_data.get("roles", {}):
            return jsonify({"error": f"Role '{key}' already exists"}), 400

        # Build permissions dict — default to false for unlisted pages
        role_perms = {}
        for page in _ALL_PAGES:
            role_perms[page] = bool(perms.get(page, False))

        roles = permissions_data.setdefault("roles", {})
        roles[key] = {
            "displayName": display_name or key,
            "permissions": role_perms,
        }
        try:
            _save_permissions()
        except Exception as e:
            del roles[key]
            return jsonify({"error": f"Failed to save: {e}"}), 500

        actor = get_actor()
        db.log_action(get_tablet_id(), "role:create", key,
                      json.dumps({"displayName": display_name}), "OK", 0, actor=actor)
        return jsonify({"success": True, "key": key}), 201

    @app.route("/api/roles/<role_key>", methods=["PUT"])
    def api_roles_update(role_key):
        """Update an existing role's display name and/or permissions."""
        roles = permissions_data.get("roles", {})
        if role_key not in roles:
            return jsonify({"error": f"Role '{role_key}' not found"}), 404

        data = request.get_json(silent=True) or {}
        changed = {}

        if "displayName" in data:
            name = (data["displayName"] or "").strip()
            if name:
                roles[role_key]["displayName"] = name
                changed["displayName"] = name

        if "permissions" in data:
            perms = data["permissions"]
            role_perms = roles[role_key].get("permissions", {})
            for page in _ALL_PAGES:
                if page in perms:
                    role_perms[page] = bool(perms[page])
            roles[role_key]["permissions"] = role_perms
            changed["permissions"] = role_perms

        if not changed:
            return jsonify({"error": "No fields to update"}), 400

        try:
            _save_permissions()
        except Exception as e:
            return jsonify({"error": f"Failed to save: {e}"}), 500

        actor = get_actor()
        db.log_action(get_tablet_id(), "role:update", role_key,
                      json.dumps(changed), "OK", 0, actor=actor)
        return jsonify({"success": True})

    @app.route("/api/roles/<role_key>", methods=["DELETE"])
    def api_roles_delete(role_key):
        """Delete a role. Prevents deleting full_access or roles in use by users."""
        roles = permissions_data.get("roles", {})
        if role_key not in roles:
            return jsonify({"error": f"Role '{role_key}' not found"}), 404
        if role_key == "full_access":
            return jsonify({"error": "Cannot delete the full_access role"}), 400

        # Check if any users are assigned this role
        if user_module:
            users = user_module.list_users()
            assigned = [u["username"] for u in users if u.get("role") == role_key]
            if assigned:
                return jsonify({
                    "error": f"Role is assigned to user(s): {', '.join(assigned)}. "
                             f"Reassign them first."
                }), 400

        # Check if any locations reference this role
        locations = permissions_data.get("locations", {})
        loc_refs = [k for k, v in locations.items() if v.get("defaultRole") == role_key]
        if loc_refs:
            return jsonify({
                "error": f"Role is used as default for location(s): {', '.join(loc_refs)}. "
                         f"Update them first."
            }), 400

        del roles[role_key]
        try:
            _save_permissions()
        except Exception as e:
            return jsonify({"error": f"Failed to save: {e}"}), 500

        actor = get_actor()
        db.log_action(get_tablet_id(), "role:delete", role_key, "", "OK", 0, actor=actor)
        return jsonify({"success": True})
