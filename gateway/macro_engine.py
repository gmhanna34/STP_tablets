"""Macro parsing, execution, and step type implementations."""

from __future__ import annotations

import concurrent.futures
import json
import logging
import os
import socket
import time
from typing import Any, Dict, List, Optional, Set

import requests as http_requests
import yaml

from auth import get_tablet_id

logger = logging.getLogger("stp-gateway")


# ---------------------------------------------------------------------------
# Verification queue — in-memory, per-macro-execution
# ---------------------------------------------------------------------------

class _VerificationEntry:
    """Tracks a pending background verification for an ha_service step."""
    __slots__ = ("entity_id", "expected_state", "timeout", "retries",
                 "original_step", "queued_at")

    def __init__(self, entity_id: str, expected_state: str, timeout: float,
                 retries: int, original_step: dict):
        self.entity_id = entity_id
        self.expected_state = expected_state
        self.timeout = timeout
        self.retries = retries
        self.original_step = original_step
        self.queued_at = time.time()


class _VerificationQueue:
    """Simple in-memory queue of pending verifications for a single macro run."""

    def __init__(self):
        self._pending: List[_VerificationEntry] = []

    def add(self, entry: _VerificationEntry):
        self._pending.append(entry)

    def drain(self) -> List[_VerificationEntry]:
        items = list(self._pending)
        self._pending.clear()
        return items

    def clear(self):
        self._pending.clear()

    def __len__(self):
        return len(self._pending)


def _resolve_verify(step: dict) -> Optional[_VerificationEntry]:
    """Resolve a verify block (shorthand or explicit) on an ha_service step.

    Returns a _VerificationEntry or None if no verification is requested.
    """
    verify = step.get("verify")
    if not verify:
        return None

    if verify is True:
        # Shorthand: infer from the step itself
        data = step.get("data", {})
        entity_id = data.get("entity_id", "")
        service = step.get("service", "")
        if service in ("turn_on",):
            expected_state = "on"
        elif service in ("turn_off",):
            expected_state = "off"
        else:
            # Can't infer state for non-turn_on/turn_off services
            return None
        if not entity_id:
            return None
        return _VerificationEntry(
            entity_id=entity_id,
            expected_state=expected_state,
            timeout=10,
            retries=2,
            original_step=step,
        )

    if isinstance(verify, dict):
        data = step.get("data", {})
        entity_id = verify.get("entity_id", data.get("entity_id", ""))
        service = step.get("service", "")
        if "state" in verify:
            expected_state = str(verify["state"])
        elif service in ("turn_on",):
            expected_state = "on"
        elif service in ("turn_off",):
            expected_state = "off"
        else:
            return None
        if not entity_id:
            return None
        return _VerificationEntry(
            entity_id=entity_id,
            expected_state=expected_state,
            timeout=verify.get("timeout", 10),
            retries=verify.get("retries", 2),
            original_step=step,
        )

    return None


# YAML parses bare on:/off:/yes:/no: as boolean True/False keys.
# Recursively convert them back to their intended string names.
_BOOL_KEY_MAP = {True: "on", False: "off"}


def _normalize_yaml_keys(obj):
    if isinstance(obj, dict):
        return {_BOOL_KEY_MAP.get(k, k) if isinstance(k, bool) else k: _normalize_yaml_keys(v)
                for k, v in obj.items()}
    if isinstance(obj, list):
        return [_normalize_yaml_keys(i) for i in obj]
    return obj


def _collect_ha_entities(binding, ha_state_entities: set):
    """Extract HA entity IDs from a state/badge/disabled_when binding."""
    if not binding or binding.get("source") != "ha":
        return
    if binding.get("entity"):
        ha_state_entities.add(binding["entity"])
    for eid in (binding.get("entities") or []):
        ha_state_entities.add(eid)


def load_macros(cfg: dict, logger_inst) -> tuple:
    """Load macros.yaml, normalize keys, collect HA entities.

    Returns (macros_cfg, macro_defs, button_defs, ha_state_entities).
    """
    macros_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "macros.yaml")
    try:
        with open(macros_path, "r") as f:
            macros_cfg = yaml.safe_load(f) or {}
    except Exception as e:
        logger_inst.warning(f"Could not load macros.yaml: {e}")
        macros_cfg = {}

    macros_cfg = _normalize_yaml_keys(macros_cfg)

    macro_defs = macros_cfg.get("macros", {})
    button_defs = macros_cfg.get("buttons", {})

    # Collect all HA entity IDs referenced by button state bindings
    ha_state_entities: set = set()
    for page_sections in button_defs.values():
        for section in page_sections:
            for item in section.get("items", []):
                _collect_ha_entities(item.get("state"), ha_state_entities)
                toggle = item.get("toggle")
                if toggle:
                    _collect_ha_entities(toggle.get("state"), ha_state_entities)
                _collect_ha_entities(item.get("badge"), ha_state_entities)
                _collect_ha_entities(item.get("disabled_when"), ha_state_entities)
            _collect_ha_entities(section.get("disabled_when"), ha_state_entities)

    return macros_cfg, macro_defs, button_defs, ha_state_entities


def fetch_ha_button_states(ctx) -> Optional[dict]:
    """Fetch current HA entity states for all button state bindings.

    Returns a dict of {entity_id: {state, attributes}} or None.
    Used by both the background poller and post-macro immediate refresh.
    """
    ha_state_entities = ctx.ha_state_entities
    if not ha_state_entities:
        return None
    if ctx.mock_mode:
        return {e: {"state": "on", "attributes": {}} for e in ha_state_entities}
    try:
        all_entities, err = fetch_all_ha_entities(ctx)
        if err:
            logger.debug(f"HA bulk fetch failed: {err}")
            return {e: {"state": "unavailable", "attributes": {}} for e in ha_state_entities}
        states = {}
        for entity in all_entities:
            eid = entity.get("entity_id", "")
            if eid in ha_state_entities:
                states[eid] = {
                    "state": entity.get("state", "unknown"),
                    "attributes": entity.get("attributes", {}),
                }
        for eid in ha_state_entities:
            if eid not in states:
                states[eid] = {"state": "unavailable", "attributes": {}}
        return states
    except Exception as e:
        logger.debug(f"HA bulk fetch error: {e}")
        return {eid: {"state": "unavailable", "attributes": {}} for eid in ha_state_entities}


def fetch_all_ha_entities(ctx):
    """Fetch all entity states from Home Assistant in one bulk call."""
    ha_cfg = ctx.cfg.get("home_assistant", {})
    if not ha_cfg.get("url") or not ha_cfg.get("token"):
        return None, "Home Assistant not configured"
    resp = http_requests.get(
        f"{ha_cfg['url']}/api/states",
        headers={"Authorization": f"Bearer {ha_cfg['token']}"},
        timeout=ha_cfg.get("timeout", 10),
    )
    if resp.status_code != 200:
        return None, f"HA returned {resp.status_code}"
    return resp.json(), None


# ---------------------------------------------------------------------------
# Macro execution
# ---------------------------------------------------------------------------

def execute_macro(ctx, macro_key: str, tablet: str, depth: int = 0,
                  skip_steps: set = None, prefix: str = "",
                  verify_queue: _VerificationQueue = None) -> dict:
    """Execute a macro by key. Returns {success, steps_completed, steps_total, error}.
    skip_steps: set of dot-notation indices to skip (e.g., {"0", "1.2", "3"}).
    prefix: current nesting path (e.g., "0." for first nested macro).
    verify_queue: shared verification queue (created at top-level, passed to children).
    """
    if skip_steps is None:
        skip_steps = set()
    # Top-level invocation creates and owns the verification queue
    owns_queue = verify_queue is None
    if owns_queue:
        verify_queue = _VerificationQueue()
    if depth > 5:
        return {"success": False, "error": "Max nesting depth (5) exceeded"}

    macro = ctx.macro_defs.get(macro_key)
    if not macro:
        return {"success": False, "error": f"Unknown macro: {macro_key}"}

    steps = macro.get("steps", [])
    label = macro.get("label", macro_key)

    if not steps:
        return {"success": True, "steps_completed": 0, "steps_total": 0}

    socketio = ctx.socketio
    db = ctx.db
    verbose = ctx.verbose_logging

    # Broadcast: macro starting
    socketio.emit("macro:progress", {
        "macro": macro_key,
        "label": label,
        "status": "started",
        "tablet": tablet,
        "steps_total": len(steps),
        "steps_completed": 0,
    })

    completed = 0
    ran_ha_service = False
    issues = []  # Track skipped/failed-then-skipped steps for warning toasts
    overall_start = time.time()

    for i, step in enumerate(steps):
        step_path = f"{prefix}{i}"
        step_type = step.get("type", "")
        step_msg = step.get("message", "")
        on_fail = step.get("on_fail", "abort")

        # Check if this step should be skipped
        if step_path in skip_steps:
            logger.info(f"Macro {macro_key} step {i+1} skipped by user (path={step_path})")
            completed += 1
            continue

        # Broadcast: step starting
        socketio.emit("macro:progress", {
            "macro": macro_key,
            "label": label,
            "status": "in_progress",
            "tablet": tablet,
            "steps_total": len(steps),
            "steps_completed": completed,
            "current_step": step_msg or f"Step {i+1}: {step_type}",
        })

        # For nested macros, pass down the skip_steps with adjusted prefix
        if step_type == "macro":
            child_key = step.get("macro", "")
            child_prefix = f"{step_path}."
            result = execute_macro(ctx, child_key, tablet, depth + 1,
                                   skip_steps=skip_steps, prefix=child_prefix,
                                   verify_queue=verify_queue)
        else:
            result = _execute_step(ctx, step, tablet, depth, verify_queue=verify_queue)

        if verbose.is_set():
            status_str = "OK" if result["success"] else f"FAIL: {result.get('error', '')}"
            logger.debug(f"[VERBOSE] Macro {macro_key} step {i+1}/{len(steps)} "
                         f"type={step_type} {status_str}")

        if result["success"]:
            completed += 1
            if step_type == "ha_service":
                ran_ha_service = True
        else:
            # Handle on_fail
            if on_fail == "skip":
                step_error = result.get("error", "unknown")
                logger.warning(f"Macro {macro_key} step {i+1} skipped: {step_error}")
                issues.append(f"Step {i+1} skipped: {step_msg or step_type} — {step_error}")
                completed += 1
                continue
            elif on_fail.startswith("retry:"):
                retries = int(on_fail.split(":")[1])
                retry_ok = False
                for attempt in range(retries):
                    time.sleep(1)
                    result = _execute_step(ctx, step, tablet, depth)
                    if result["success"]:
                        retry_ok = True
                        break
                if retry_ok:
                    completed += 1
                    continue
                # All retries exhausted — fall through to abort

            # Abort
            overall_ms = (time.time() - overall_start) * 1000
            step_error = result.get("error", "")
            error_msg = (f"{step_msg}: {step_error}" if step_msg and step_error
                         else step_error or step_msg or f"Step {i+1} ({step_type}) failed")

            socketio.emit("macro:progress", {
                "macro": macro_key,
                "label": label,
                "status": "failed",
                "tablet": tablet,
                "steps_total": len(steps),
                "steps_completed": completed,
                "error": error_msg,
            })

            db.log_action(tablet, "macro:execute", macro_key,
                          json.dumps({"label": label, "steps": len(steps)}),
                          f"FAILED at step {i+1}: {error_msg}", overall_ms)

            # Clear verification queue on failure (top-level only)
            if owns_queue:
                verify_queue.clear()

            # Refresh HA state even on failure
            if ran_ha_service:
                _refresh_ha_state(ctx)

            return {
                "success": False,
                "macro": macro_key,
                "label": label,
                "steps_completed": completed,
                "steps_total": len(steps),
                "error": error_msg,
                "latency_ms": round(overall_ms, 1),
            }

    # Clear verification queue at macro end (top-level only)
    if owns_queue:
        verify_queue.clear()

    # All steps completed
    overall_ms = (time.time() - overall_start) * 1000

    progress_data = {
        "macro": macro_key,
        "label": label,
        "status": "completed",
        "tablet": tablet,
        "steps_total": len(steps),
        "steps_completed": completed,
    }
    if issues:
        progress_data["issues"] = issues
        progress_data["issue_count"] = len(issues)
    socketio.emit("macro:progress", progress_data)

    db.log_action(tablet, "macro:execute", macro_key,
                  json.dumps({"label": label, "steps": len(steps)}),
                  f"OK {completed}/{len(steps)} steps", overall_ms)

    # Force fresh MoIP state broadcast so button highlights update immediately
    try:
        if ctx.moip is not None:
            fresh, fresh_status = ctx.moip.get_receivers()
            if fresh_status < 400 and fresh:
                ctx.state_cache.set("moip", fresh)
                socketio.emit("state:moip", fresh, room="moip")
    except Exception as e:
        logger.debug(f"MoIP state refresh after macro failed: {e}")

    # Force fresh HA state broadcast
    if ran_ha_service:
        _refresh_ha_state(ctx)

    result = {
        "success": True,
        "macro": macro_key,
        "label": label,
        "steps_completed": completed,
        "steps_total": len(steps),
        "latency_ms": round(overall_ms, 1),
    }
    if issues:
        result["issues"] = issues
        result["issue_count"] = len(issues)
    return result


def _refresh_ha_state(ctx):
    """Refresh HA button states and broadcast to all tablets."""
    try:
        ha_fresh = fetch_ha_button_states(ctx)
        if ha_fresh:
            ctx.state_cache.set("ha", ha_fresh)
            ctx.socketio.emit("state:ha", ha_fresh, room="ha")
    except Exception as e:
        logger.debug(f"HA state refresh after macro: {e}")


def _execute_step(ctx, step: dict, tablet: str, depth: int,
                   verify_queue: _VerificationQueue = None) -> dict:
    """Execute a single macro step. Returns {success, error?}."""
    step_type = step.get("type", "")
    try:
        if step_type == "ha_check":
            return _step_ha_check(ctx, step)
        elif step_type == "ha_service":
            result = _step_ha_service(ctx, step, tablet)
            # Queue background verification whether the call succeeded or failed.
            # On success: verify the device actually changed state.
            # On failure (with on_fail: skip): verify_pending will retry the call,
            # catching transient HA 500 errors that would otherwise be silently skipped.
            if verify_queue is not None:
                on_fail = step.get("on_fail", "abort")
                should_queue = result["success"] or on_fail == "skip"
                if should_queue:
                    entry = _resolve_verify(step)
                    if entry:
                        verify_queue.add(entry)
                        status = "ok" if result["success"] else "failed"
                        logger.debug(f"Queued verification for {entry.entity_id} "
                                     f"(expect={entry.expected_state}, call={status})")
            return result
        elif step_type == "door_timed_unlock":
            return _step_door_timed_unlock(ctx, step, tablet)
        elif step_type == "moip_switch":
            return _step_moip_switch(ctx, step, tablet)
        elif step_type == "moip_ir":
            return _step_moip_ir(ctx, step, tablet)
        elif step_type == "epson_power":
            return _step_epson_power(ctx, step, tablet)
        elif step_type == "epson_all":
            return _step_epson_all(ctx, step, tablet)
        elif step_type == "x32_scene":
            return _step_x32_scene(ctx, step, tablet)
        elif step_type == "x32_mute":
            return _step_x32_mute(ctx, step, tablet)
        elif step_type == "x32_aux_mute":
            return _step_x32_aux_mute(ctx, step, tablet)
        elif step_type == "obs_emit":
            return _step_obs_emit(ctx, step, tablet)
        elif step_type == "ptz_preset":
            return _step_ptz_preset(ctx, step, tablet)
        elif step_type == "parallel":
            return _step_parallel(ctx, step, tablet, depth, verify_queue=verify_queue)
        elif step_type == "delay":
            secs = step.get("seconds", 1)
            time.sleep(secs)
            return {"success": True}
        elif step_type == "macro":
            child_key = step.get("macro", "")
            return execute_macro(ctx, child_key, tablet, depth + 1,
                                 verify_queue=verify_queue)
        elif step_type == "condition":
            return _step_condition(ctx, step, tablet, depth, verify_queue=verify_queue)
        elif step_type == "tts_announce":
            return _step_tts_announce(ctx, step, tablet)
        elif step_type == "notify":
            msg = step.get("message", "")
            ctx.socketio.emit("notification", {"message": msg})
            return {"success": True}
        elif step_type == "wait_until":
            return _step_wait_until(ctx, step, tablet)
        elif step_type == "verify_pending":
            return _step_verify_pending(ctx, step, tablet, verify_queue)
        else:
            return {"success": False, "error": f"Unknown step type: {step_type}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Individual step type implementations
# ---------------------------------------------------------------------------

def _step_ha_check(ctx, step: dict) -> dict:
    entity = step.get("entity", "")
    expect = step.get("expect", "")
    ha_cfg = ctx.cfg.get("home_assistant", {})
    if ctx.mock_mode:
        return {"success": True}
    try:
        resp = http_requests.get(
            f"{ha_cfg['url']}/api/states/{entity}",
            headers={"Authorization": f"Bearer {ha_cfg['token']}"},
            timeout=ha_cfg.get("timeout", 10),
        )
        data = resp.json()
        actual = data.get("state", "")
        if str(actual) == str(expect):
            return {"success": True}
        return {"success": False, "error": f"{entity} is '{actual}', expected '{expect}'"}
    except Exception as e:
        return {"success": False, "error": f"HA check failed: {e}"}


def _step_ha_service(ctx, step: dict, tablet: str) -> dict:
    domain = step.get("domain", "")
    service = step.get("service", "")
    data = step.get("data", {})
    ha_cfg = ctx.cfg.get("home_assistant", {})
    verbose = ctx.verbose_logging
    if verbose.is_set():
        logger.debug(f"[VERBOSE] ha_service: {domain}/{service}, data={json.dumps(data)[:200]}")
    if ctx.mock_mode:
        return {"success": True}
    try:
        resp = http_requests.post(
            f"{ha_cfg['url']}/api/services/{domain}/{service}",
            headers={
                "Authorization": f"Bearer {ha_cfg['token']}",
                "Content-Type": "application/json",
            },
            json=data,
            timeout=ha_cfg.get("timeout", 10),
        )
        ok = resp.status_code < 400
        if verbose.is_set():
            logger.debug(f"[VERBOSE] ha_service result: {domain}/{service} status={resp.status_code}")
        if ok:
            ctx.db.log_action(tablet, f"macro:ha:{domain}/{service}", "home_assistant",
                              json.dumps(data)[:500], f"status={resp.status_code}", 0)
        else:
            resp_body = ""
            try:
                resp_body = resp.text[:300]
            except Exception as e:
                logger.debug(f"Could not read HA response body: {e}")
            logger.warning(f"ha_service FAILED: {domain}/{service} status={resp.status_code} "
                           f"data={json.dumps(data)[:200]} response={resp_body}")
            ctx.db.log_action(tablet, f"macro:ha:{domain}/{service}", "home_assistant",
                              json.dumps(data)[:500], f"FAILED status={resp.status_code}: {resp_body[:200]}", 0)
        return {"success": ok, "error": "" if ok else f"HA {domain}/{service} returned {resp.status_code}"}
    except Exception as e:
        return {"success": False, "error": f"HA service failed: {e}"}


def _step_door_timed_unlock(ctx, step: dict, tablet: str) -> dict:
    """Unlock a door for a given duration using the HA lock cache to resolve entities and options."""
    lock_entity = step.get("entity", "")
    minutes = step.get("minutes", 60)
    ha_cfg = ctx.cfg.get("home_assistant", {})

    if ctx.mock_mode:
        return {"success": True}

    # Find the lock in the HA device cache
    with ctx.ha_cache_lock:
        locks = list(ctx.ha_device_cache.get("locks", []))
    lock = next((l for l in locks if l["entity_id"] == lock_entity), None)
    if not lock:
        return {"success": False, "error": f"Lock entity {lock_entity} not found in HA cache"}

    dur_entity = lock.get("duration_entity")
    rule_entity = lock.get("lock_rule_entity")
    rule_options = lock.get("lock_rule_options") or []

    if not dur_entity or not rule_entity:
        return {"success": False, "error": f"Lock {lock_entity} missing duration or rule entity"}

    # Resolve the "custom" option string dynamically
    custom_option = next((opt for opt in rule_options if "custom" in opt.lower()), None)
    if not custom_option:
        return {"success": False, "error": f"No 'custom' option found in {rule_entity} options: {rule_options}"}

    dur_domain = dur_entity.split(".")[0]
    rule_domain = rule_entity.split(".")[0]
    errors = []

    # Step 1: Set the duration
    try:
        resp = http_requests.post(
            f"{ha_cfg['url']}/api/services/{dur_domain}/set_value",
            headers={"Authorization": f"Bearer {ha_cfg['token']}", "Content-Type": "application/json"},
            json={"entity_id": dur_entity, "value": minutes},
            timeout=ha_cfg.get("timeout", 10),
        )
        if resp.status_code >= 400:
            errors.append(f"set_value {dur_entity}={minutes} returned {resp.status_code}")
    except Exception as e:
        errors.append(f"set_value {dur_entity}: {e}")

    # Step 2: Trigger the custom rule option
    try:
        resp = http_requests.post(
            f"{ha_cfg['url']}/api/services/{rule_domain}/select_option",
            headers={"Authorization": f"Bearer {ha_cfg['token']}", "Content-Type": "application/json"},
            json={"entity_id": rule_entity, "option": custom_option},
            timeout=ha_cfg.get("timeout", 10),
        )
        if resp.status_code >= 400:
            errors.append(f"select_option {rule_entity}='{custom_option}' returned {resp.status_code}")
    except Exception as e:
        errors.append(f"select_option {rule_entity}: {e}")

    ok = len(errors) == 0
    friendly = lock.get("friendly_name", lock_entity)
    ctx.db.log_action(tablet, "macro:door_timed_unlock", friendly,
                      json.dumps({"entity": lock_entity, "minutes": minutes, "option": custom_option}),
                      "OK" if ok else f"FAILED: {'; '.join(errors)}", 0)

    if ok:
        logger.info(f"Door unlocked: {friendly} for {minutes}min (option='{custom_option}')")
        return {"success": True}
    return {"success": False, "error": "; ".join(errors)}


def _step_moip_switch(ctx, step: dict, tablet: str) -> dict:
    tx = str(step.get("tx", ""))
    rx = str(step.get("rx", ""))
    verbose = ctx.verbose_logging
    if verbose.is_set():
        logger.debug(f"[VERBOSE] moip_switch: tx={tx}, rx={rx}, tablet={tablet}")
    if ctx.mock_mode:
        return {"success": True}
    start = time.time()
    result, status = ctx.moip.switch(tx, rx)
    latency = (time.time() - start) * 1000
    ok = status < 400
    if verbose.is_set():
        logger.debug(f"[VERBOSE] moip_switch result: tx={tx}->rx={rx} status={status}")
    ctx.db.log_action(tablet, "macro:moip_switch", f"TX{tx}->RX{rx}",
                      json.dumps({"tx": tx, "rx": rx}),
                      "OK" if ok else f"FAILED status={status}", latency)
    if ok:
        ctx.socketio.emit("state:moip", {"event": "switch", "data": {"transmitter": tx, "receiver": rx}}, room="moip")
    return {"success": ok, "error": "" if ok else f"MoIP switch failed: tx={tx}, rx={rx}, status={status}"}


def _step_moip_ir(ctx, step: dict, tablet: str) -> dict:
    rx = str(step.get("receiver", ""))
    code_name = step.get("code", "")
    ir_codes = ctx.devices_data.get("moip", {}).get("irCodes", {})
    code = ir_codes.get(code_name, code_name)
    if code_name not in ir_codes:
        logger.warning(f"IR code name '{code_name}' not found in devices.json irCodes")
    verbose = ctx.verbose_logging
    if verbose.is_set():
        logger.debug(f"[VERBOSE] moip_ir: receiver={rx}, code_name={code_name}, tablet={tablet}")
    if ctx.mock_mode:
        return {"success": True}
    start = time.time()
    result, status = ctx.moip.send_ir("0", rx, code)
    latency = (time.time() - start) * 1000
    ok = status < 400
    if verbose.is_set():
        logger.debug(f"[VERBOSE] moip_ir result: receiver={rx}, code={code}, "
                     f"status={status}, response={json.dumps(result)[:200]}")
    ctx.db.log_action(tablet, "macro:moip_ir", f"RX{rx}:{code_name}",
                      json.dumps({"rx": rx, "code_name": code_name}),
                      "OK" if ok else f"FAILED status={status}", latency)
    if not ok:
        logger.warning(f"moip_ir FAILED: receiver={rx}, code={code}, status={status}")
    return {"success": ok, "error": "" if ok else f"IR failed: receiver={rx}, code={code}, status={status}"}


def _step_epson_power(ctx, step: dict, tablet: str) -> dict:
    key = step.get("projector", "")
    state = step.get("state", "on")
    projectors = ctx.cfg.get("projectors", {})
    proj = projectors.get(key)
    if not proj:
        return {"success": False, "error": f"Unknown projector: {key}"}
    if ctx.mock_mode:
        return {"success": True}
    try:
        start = time.time()
        resp = http_requests.get(
            f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}", timeout=20)
        latency = (time.time() - start) * 1000
        ok = resp.status_code == 200
        ctx.socketio.emit("state:projectors", {"event": "power", "projector": key, "state": state}, room="projectors")
        ctx.db.log_action(tablet, "macro:epson_power", key,
                          json.dumps({"projector": key, "state": state}),
                          "OK" if ok else f"FAILED status={resp.status_code}", latency)
        if ok:
            return {"success": True}
        return {"success": False, "error": f"Projector {key} returned HTTP {resp.status_code}"}
    except Exception as e:
        ctx.db.log_action(tablet, "macro:epson_power", key,
                          json.dumps({"projector": key, "state": state}),
                          f"FAILED: {e}", 0)
        return {"success": False, "error": str(e)}


def _step_epson_all(ctx, step: dict, tablet: str) -> dict:
    state = step.get("state", "on")
    projectors = ctx.cfg.get("projectors", {})
    if ctx.mock_mode:
        return {"success": True}
    for key, proj in projectors.items():
        try:
            http_requests.get(
                f"http://{proj['ip']}/api/v01/contentmgr/remote/power/{state}", timeout=20)
        except Exception as e:
            logger.debug(f"Projector {key} power command failed: {e}")
    ctx.socketio.emit("state:projectors", {"event": "all_power", "state": state}, room="projectors")
    return {"success": True}


def _step_x32_scene(ctx, step: dict, tablet: str) -> dict:
    num = step.get("scene", 0)
    if ctx.mock_mode:
        return {"success": True}
    start = time.time()
    result, status = ctx.x32.set_scene(num)
    latency = (time.time() - start) * 1000
    ok = status < 400
    error_detail = "" if not ok else ""
    if not ok:
        error_detail = result.get("error", "") if isinstance(result, dict) else str(result)
    ctx.db.log_action(tablet, "macro:x32_scene", f"scene_{num}",
                      json.dumps({"scene": num}),
                      "OK" if ok else f"FAILED: {error_detail}" if error_detail else "FAILED", latency)
    if ok:
        ctx.socketio.emit("state:x32", {"event": "scene", "scene": num}, room="x32")
        return {"success": True}
    return {"success": False, "error": error_detail or f"X32 scene {num} failed"}


def _step_x32_mute(ctx, step: dict, tablet: str) -> dict:
    ch = step.get("channel", 1)
    state = step.get("state", "on")
    if ctx.mock_mode:
        return {"success": True}
    start = time.time()
    result, status = ctx.x32.mute_channel(ch, state)
    latency = (time.time() - start) * 1000
    ok = status < 400
    error_detail = "" if ok else (result.get("error", "") if isinstance(result, dict) else str(result))
    ctx.db.log_action(tablet, "macro:x32_mute", f"ch{ch}_{state}",
                      json.dumps({"channel": ch, "state": state}),
                      "OK" if ok else f"FAILED: {error_detail}" if error_detail else "FAILED", latency)
    if ok:
        ctx.socketio.emit("state:x32", {"event": "mute", "channel": ch, "state": state}, room="x32")
        return {"success": True}
    return {"success": False, "error": error_detail or f"X32 mute ch{ch} failed"}


def _step_x32_aux_mute(ctx, step: dict, tablet: str) -> dict:
    ch = step.get("channel", 1)
    state = step.get("state", "on")
    if ctx.mock_mode:
        return {"success": True}
    start = time.time()
    result, status = ctx.x32.mute_aux(ch, state)
    latency = (time.time() - start) * 1000
    ok = status < 400
    error_detail = "" if ok else (result.get("error", "") if isinstance(result, dict) else str(result))
    ctx.db.log_action(tablet, "macro:x32_aux_mute", f"aux{ch}_{state}",
                      json.dumps({"channel": ch, "state": state}),
                      "OK" if ok else f"FAILED: {error_detail}" if error_detail else "FAILED", latency)
    if ok:
        ctx.socketio.emit("state:x32", {"event": "aux_mute", "aux": ch, "state": state}, room="x32")
        return {"success": True}
    return {"success": False, "error": error_detail or f"X32 aux{ch} mute failed"}


def _step_obs_emit(ctx, step: dict, tablet: str) -> dict:
    action = step.get("action", "")
    payload = step.get("data")
    if ctx.mock_mode:
        return {"success": True}
    start = time.time()
    err = ctx.obs.emit(action, payload)
    latency = (time.time() - start) * 1000
    ok = err is None
    ctx.db.log_action(tablet, "macro:obs_emit", action,
                      json.dumps(payload)[:500] if payload else "",
                      "OK" if ok else f"FAILED: {err}", latency)
    if ok:
        ctx.socketio.emit("state:obs", {"event": action, "data": payload}, room="obs")
        return {"success": True}
    return {"success": False, "error": err or f"OBS {action} failed"}


def _step_ptz_preset(ctx, step: dict, tablet: str) -> dict:
    cam_key = step.get("camera", "")
    preset = step.get("preset", 1)
    cameras = ctx.cfg.get("ptz_cameras", {})
    cam = cameras.get(cam_key)
    if not cam:
        return {"success": False, "error": f"Unknown camera: {cam_key}"}
    if ctx.mock_mode:
        return {"success": True}
    try:
        start = time.time()
        resp = http_requests.get(
            f"http://{cam['ip']}/cgi-bin/ptzctrl.cgi?ptzcmd&poscall&{preset}", timeout=3)
        latency = (time.time() - start) * 1000
        ok = resp.status_code == 200
        ctx.db.log_action(tablet, "macro:ptz_preset", f"{cam_key}:preset_{preset}",
                          json.dumps({"camera": cam_key, "preset": preset}),
                          "OK" if ok else f"FAILED status={resp.status_code}", latency)
        if ok:
            return {"success": True}
        return {"success": False, "error": f"Camera {cam_key} preset {preset} failed (HTTP {resp.status_code})"}
    except Exception as e:
        ctx.db.log_action(tablet, "macro:ptz_preset", f"{cam_key}:preset_{preset}",
                          json.dumps({"camera": cam_key, "preset": preset}),
                          f"FAILED: {e}", 0)
        return {"success": False, "error": str(e)}


def _get_lan_ip() -> str:
    """Return this machine's LAN IP (not 127.0.0.1)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _step_tts_announce(ctx, step: dict, tablet: str) -> dict:
    """Execute a TTS announcement step (preset, sequence, or inline text)."""
    if not ctx.announcements:
        return {"success": False, "error": "Announcement module not available"}
    # Build gateway origin for audio URLs — must use a LAN-reachable IP
    # so the WiiM speaker (via HA play_media) can fetch the audio file.
    # 127.0.0.1 is unreachable from external devices.
    gw_cfg = ctx.cfg.get("gateway", {})
    port = gw_cfg.get("port", 20858)
    lan_ip = _get_lan_ip()
    gateway_origin = f"http://{lan_ip}:{port}"
    result = ctx.announcements.execute_macro_step(step, gateway_origin, tablet)
    ok = result.get("success", False) and "error" not in result
    if ok:
        return {"success": True}
    return {"success": False, "error": result.get("error", "TTS announce failed")}


def _step_parallel(ctx, step: dict, tablet: str, depth: int,
                    verify_queue: _VerificationQueue = None) -> dict:
    """Run sub-steps concurrently. Succeeds only if ALL sub-steps succeed."""
    sub_steps = step.get("steps", [])
    if not sub_steps:
        return {"success": True}

    on_fail = step.get("on_fail", "abort")

    def run_sub(sub_step):
        sub_type = sub_step.get("type", "")
        if sub_type == "macro":
            child_key = sub_step.get("macro", "")
            return execute_macro(ctx, child_key, tablet, depth + 1,
                                 verify_queue=verify_queue)
        return _execute_step(ctx, sub_step, tablet, depth, verify_queue=verify_queue)

    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(sub_steps)) as pool:
        futures = {pool.submit(run_sub, s): s for s in sub_steps}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            if not result["success"]:
                sub = futures[future]
                sub_on_fail = sub.get("on_fail", on_fail)
                if sub_on_fail == "skip":
                    logger.warning(f"Parallel sub-step skipped: {result.get('error', '')}")
                else:
                    errors.append(result.get("error", "unknown error"))

    if errors:
        return {"success": False, "error": f"Parallel failures: {'; '.join(errors)}"}
    return {"success": True}


def _step_condition(ctx, step: dict, tablet: str, depth: int,
                    verify_queue: _VerificationQueue = None) -> dict:
    check = step.get("if", {})
    then_steps = step.get("then", [])
    else_steps = step.get("else", [])

    check_result = _execute_step(ctx, check, tablet, depth, verify_queue=verify_queue)

    branch = then_steps if check_result["success"] else else_steps
    for sub_step in branch:
        result = _execute_step(ctx, sub_step, tablet, depth, verify_queue=verify_queue)
        if not result["success"]:
            return result
    return {"success": True}


# ---------------------------------------------------------------------------
# wait_until — poll a device module or HA entity until ready
# ---------------------------------------------------------------------------

def _step_wait_until(ctx, step: dict, tablet: str) -> dict:
    """Poll a device module or HA entity until it reaches expected state or times out."""
    timeout = step.get("timeout", 30)
    poll_interval = step.get("poll_interval", 2)
    message = step.get("message", "Waiting for device")
    target = step.get("target", "")        # module name: x32, obs, moip
    entity_id = step.get("entity_id", "")  # HA entity to poll
    condition = step.get("condition", "")   # for modules: "connected"
    expected_state = step.get("state", "")  # for HA entities

    if ctx.mock_mode:
        return {"success": True}

    start = time.time()
    attempt = 0

    while True:
        elapsed = time.time() - start
        if elapsed >= timeout:
            return {"success": False,
                    "error": f"wait_until timed out after {timeout}s: {message}"}

        met = False

        # Module-based check
        if target and condition == "connected":
            met = _check_module_connected(ctx, target)
        # HA entity check
        elif entity_id and expected_state:
            met = _check_ha_entity_state(ctx, entity_id, expected_state)

        if met:
            logger.info(f"wait_until satisfied after {elapsed:.1f}s: {message}")
            return {"success": True}

        attempt += 1
        # Emit progress so tablets can show waiting status
        ctx.socketio.emit("macro_step_status", {
            "type": "wait_until",
            "message": message,
            "elapsed": round(elapsed, 1),
            "timeout": timeout,
            "attempt": attempt,
        })

        time.sleep(poll_interval)


def _check_module_connected(ctx, target: str) -> bool:
    """Check if a device module reports as connected/healthy."""
    try:
        if target == "x32" and ctx.x32:
            status, _code = ctx.x32.get_status()
            return status.get("healthy", False) if isinstance(status, dict) else False
        elif target == "obs" and ctx.obs:
            status, _code = ctx.obs.get_status()
            return status.get("healthy", False) if isinstance(status, dict) else False
        elif target == "moip" and ctx.moip:
            status = ctx.moip.get_status()
            return status.get("healthy", False) if isinstance(status, dict) else False
    except Exception as e:
        logger.debug(f"Module health check failed for {target}: {e}")
    return False


def _check_ha_entity_state(ctx, entity_id: str, expected_state: str) -> bool:
    """Check a single HA entity against an expected state."""
    ha_cfg = ctx.cfg.get("home_assistant", {})
    if not ha_cfg.get("url") or not ha_cfg.get("token"):
        return False
    try:
        resp = http_requests.get(
            f"{ha_cfg['url']}/api/states/{entity_id}",
            headers={"Authorization": f"Bearer {ha_cfg['token']}"},
            timeout=ha_cfg.get("timeout", 10),
        )
        if resp.status_code != 200:
            return False
        actual = resp.json().get("state", "")
        return str(actual) == str(expected_state)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# verify_pending — batch-check all queued verifications
# ---------------------------------------------------------------------------

def _step_verify_pending(ctx, step: dict, tablet: str,
                         verify_queue: _VerificationQueue) -> dict:
    """Check all pending verifications, retry failures, emit results."""
    if verify_queue is None or len(verify_queue) == 0:
        return {"success": True}

    timeout = step.get("timeout", 10)
    max_retries = step.get("retries", 2)
    poll_interval = step.get("poll_interval", 2)
    message = step.get("message", "Verifying pending steps")

    if ctx.mock_mode:
        verify_queue.clear()
        return {"success": True}

    entries = verify_queue.drain()
    ha_cfg = ctx.cfg.get("home_assistant", {})

    start = time.time()

    for retry_round in range(max_retries + 1):
        if not entries:
            break

        elapsed = time.time() - start
        if elapsed >= timeout:
            break

        # Fetch all HA states in one bulk call
        entity_states = {}
        try:
            all_entities, err = fetch_all_ha_entities(ctx)
            if not err and all_entities:
                for e in all_entities:
                    entity_states[e.get("entity_id", "")] = e.get("state", "")
        except Exception:
            pass

        still_pending = []
        for entry in entries:
            actual = entity_states.get(entry.entity_id, "unknown")
            if str(actual) == str(entry.expected_state):
                logger.debug(f"Verified {entry.entity_id} = {actual}")
            else:
                still_pending.append(entry)
                logger.debug(f"Verify failed: {entry.entity_id} is '{actual}', "
                             f"expected '{entry.expected_state}' (round {retry_round + 1})")

        if not still_pending:
            logger.info(f"All {len(entries)} verifications passed "
                        f"(round {retry_round + 1}, {time.time() - start:.1f}s)")
            return {"success": True}

        entries = still_pending

        # If not last round, retry the original ha_service calls and then wait
        if retry_round < max_retries:
            for entry in entries:
                logger.info(f"Retrying ha_service for {entry.entity_id} "
                            f"(round {retry_round + 2})")
                ctx.socketio.emit("macro_step_retry", {
                    "entity_id": entry.entity_id,
                    "expected_state": entry.expected_state,
                    "retry_round": retry_round + 2,
                })
                # Re-execute the original ha_service step
                try:
                    _step_ha_service(ctx, entry.original_step, tablet)
                except Exception as e:
                    logger.warning(f"Retry ha_service failed for {entry.entity_id}: {e}")

            # Wait before next check
            remaining = timeout - (time.time() - start)
            wait_time = min(poll_interval, remaining) if remaining > 0 else 0
            if wait_time > 0:
                time.sleep(wait_time)

    # Some verifications failed after all retries
    failed_entities = [
        {"entity_id": e.entity_id, "expected": e.expected_state}
        for e in entries
    ]
    logger.warning(f"verify_pending: {len(failed_entities)} entities failed "
                   f"after {max_retries} retries: "
                   f"{[e['entity_id'] for e in failed_entities]}")

    ctx.socketio.emit("macro_verify_failed", {
        "message": message,
        "failed": failed_entities,
        "retries_exhausted": max_retries,
    })

    # Continue the macro (don't abort — these were on_fail: skip steps)
    return {"success": True}


# ---------------------------------------------------------------------------
# Step summary (for macro expand API)
# ---------------------------------------------------------------------------

def step_summary(step: dict, macro_defs: dict) -> str:
    """Generate a human-readable summary for a step."""
    t = step.get("type", "")
    if t == "ha_check":
        return f"Check {step.get('entity', '')} == {step.get('expect', '')}"
    elif t == "ha_service":
        return f"HA {step.get('domain', '')}.{step.get('service', '')} ({step.get('data', {}).get('entity_id', '')})"
    elif t == "door_timed_unlock":
        return f"Unlock {step.get('entity', '')} for {step.get('minutes', 60)} min"
    elif t == "moip_switch":
        return f"Switch TX {step.get('tx', '')} → RX {step.get('rx', '')}"
    elif t == "moip_ir":
        return f"IR {step.get('code', '')} → RX {step.get('receiver', '')}"
    elif t == "epson_power":
        return f"Projector {step.get('projector', '')} {step.get('state', '')}"
    elif t == "epson_all":
        return f"All projectors {step.get('state', '')}"
    elif t == "x32_scene":
        return f"X32 scene {step.get('scene', '')}"
    elif t == "x32_mute":
        return f"X32 mute ch{step.get('channel', '')} {step.get('state', '')}"
    elif t == "x32_aux_mute":
        return f"X32 aux{step.get('channel', '')} mute {step.get('state', '')}"
    elif t == "obs_emit":
        return f"OBS {step.get('request_type', '')}"
    elif t == "ptz_preset":
        return f"PTZ {step.get('camera', '')} preset {step.get('preset', '')}"
    elif t == "delay":
        return f"Wait {step.get('seconds', 0)}s"
    elif t == "tts_announce":
        if step.get("preset"):
            return f"Announce preset: {step.get('preset', '')}"
        if step.get("sequence"):
            return f"Announce sequence: {step.get('sequence', '')}"
        return f"Announce: {step.get('text', '')[:50]}"
    elif t == "notify":
        return f"Notify: {step.get('message', '')}"
    elif t == "condition":
        return f"Condition: check {step.get('check', {}).get('entity', '')}"
    elif t == "macro":
        nested = step.get("macro", "")
        nested_label = macro_defs.get(nested, {}).get("label", nested)
        return f"Run macro: {nested_label}"
    elif t == "wait_until":
        target = step.get("target", step.get("entity_id", ""))
        return f"Wait for {target} ({step.get('timeout', 30)}s max)"
    elif t == "verify_pending":
        return f"Verify pending ({step.get('message', 'check all')})"
    return f"{t}"
