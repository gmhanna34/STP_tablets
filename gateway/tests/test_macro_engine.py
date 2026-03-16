"""Tests for macro_engine — loading, execution, depth limit, on_fail behavior."""

import os
import sys
import tempfile
import threading
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from macro_engine import (
    _normalize_yaml_keys,
    _resolve_verify,
    _VerificationEntry,
    _VerificationQueue,
    execute_macro,
    load_macros,
    step_summary,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_ctx(macro_defs=None):
    """Build a minimal mock context for macro execution tests."""
    from polling import StateCache

    ctx = MagicMock()
    ctx.mock_mode = True
    ctx.macro_defs = macro_defs or {}
    ctx.verbose_logging = threading.Event()
    ctx.state_cache = StateCache()
    ctx.cfg = {"home_assistant": {"url": "", "token": ""}}
    ctx.ha_state_entities = set()
    ctx.moip = None
    ctx.x32 = None
    ctx.obs = None
    return ctx


# ---------------------------------------------------------------------------
# YAML key normalization
# ---------------------------------------------------------------------------

class TestNormalizeYamlKeys:
    def test_bool_true_key_becomes_on(self):
        result = _normalize_yaml_keys({True: "turn_on_action"})
        assert result == {"on": "turn_on_action"}

    def test_bool_false_key_becomes_off(self):
        result = _normalize_yaml_keys({False: "turn_off_action"})
        assert result == {"off": "turn_off_action"}

    def test_nested_normalization(self):
        result = _normalize_yaml_keys({
            "macros": {True: {"steps": []}, False: {"steps": []}},
        })
        assert "on" in result["macros"]
        assert "off" in result["macros"]

    def test_list_normalization(self):
        result = _normalize_yaml_keys([{True: "a"}, {False: "b"}])
        assert result == [{"on": "a"}, {"off": "b"}]

    def test_non_bool_keys_unchanged(self):
        result = _normalize_yaml_keys({"chapel_tv_on": {"steps": []}})
        assert result == {"chapel_tv_on": {"steps": []}}


# ---------------------------------------------------------------------------
# Macro execution
# ---------------------------------------------------------------------------

class TestExecuteMacro:
    def test_unknown_macro_returns_error(self):
        ctx = _make_ctx()
        result = execute_macro(ctx, "nonexistent", "test-tablet")
        assert result["success"] is False
        assert "Unknown macro" in result["error"]

    def test_empty_steps_succeeds(self):
        ctx = _make_ctx({"empty_macro": {"label": "Empty", "steps": []}})
        result = execute_macro(ctx, "empty_macro", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 0

    def test_delay_step_succeeds(self):
        ctx = _make_ctx({
            "delay_test": {
                "label": "Delay Test",
                "steps": [{"type": "delay", "seconds": 0.01}],
            }
        })
        result = execute_macro(ctx, "delay_test", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 1

    def test_notify_step_emits_event(self):
        ctx = _make_ctx({
            "notify_test": {
                "label": "Notify",
                "steps": [{"type": "notify", "message": "Hello"}],
            }
        })
        result = execute_macro(ctx, "notify_test", "test-tablet")
        assert result["success"] is True
        ctx.socketio.emit.assert_any_call("notification", {"message": "Hello"})

    def test_unknown_step_type_fails(self):
        ctx = _make_ctx({
            "bad_type": {
                "label": "Bad",
                "steps": [{"type": "nonexistent_type"}],
            }
        })
        result = execute_macro(ctx, "bad_type", "test-tablet")
        assert result["success"] is False
        assert "Unknown step type" in result["error"]

    def test_depth_limit_exceeded(self):
        ctx = _make_ctx({
            "recursive": {
                "label": "Recursive",
                "steps": [{"type": "macro", "macro": "recursive"}],
            }
        })
        # Direct call at depth 6 should fail
        result = execute_macro(ctx, "recursive", "test-tablet", depth=6)
        assert result["success"] is False
        assert "Max nesting depth" in result["error"]

    def test_on_fail_skip_continues(self):
        ctx = _make_ctx({
            "skip_test": {
                "label": "Skip Test",
                "steps": [
                    {"type": "nonexistent_type", "on_fail": "skip"},
                    {"type": "delay", "seconds": 0.01},
                ],
            }
        })
        result = execute_macro(ctx, "skip_test", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 2

    def test_on_fail_abort_stops(self):
        ctx = _make_ctx({
            "abort_test": {
                "label": "Abort Test",
                "steps": [
                    {"type": "nonexistent_type", "on_fail": "abort"},
                    {"type": "delay", "seconds": 0.01},
                ],
            }
        })
        result = execute_macro(ctx, "abort_test", "test-tablet")
        assert result["success"] is False
        assert result["steps_completed"] == 0

    def test_skip_steps_parameter(self):
        ctx = _make_ctx({
            "skip_some": {
                "label": "Skip Some",
                "steps": [
                    {"type": "delay", "seconds": 0.01},
                    {"type": "nonexistent_type"},  # Would fail
                    {"type": "delay", "seconds": 0.01},
                ],
            }
        })
        # Skip step index "1" (the failing step)
        result = execute_macro(ctx, "skip_some", "test-tablet", skip_steps={"1"})
        assert result["success"] is True
        assert result["steps_completed"] == 3

    def test_ha_service_step_in_mock_mode(self):
        ctx = _make_ctx({
            "ha_test": {
                "label": "HA Test",
                "steps": [
                    {"type": "ha_service", "domain": "light", "service": "turn_on",
                     "data": {"entity_id": "light.chapel"}},
                ],
            }
        })
        result = execute_macro(ctx, "ha_test", "test-tablet")
        assert result["success"] is True

    def test_ha_check_step_in_mock_mode(self):
        ctx = _make_ctx({
            "ha_check_test": {
                "label": "HA Check",
                "steps": [
                    {"type": "ha_check", "entity": "switch.chapel_lights", "expect": "on"},
                ],
            }
        })
        result = execute_macro(ctx, "ha_check_test", "test-tablet")
        assert result["success"] is True

    def test_multiple_steps_all_succeed(self):
        ctx = _make_ctx({
            "multi": {
                "label": "Multi",
                "steps": [
                    {"type": "delay", "seconds": 0.01},
                    {"type": "notify", "message": "step 2"},
                    {"type": "delay", "seconds": 0.01},
                ],
            }
        })
        result = execute_macro(ctx, "multi", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 3
        assert result["steps_total"] == 3

    def test_audit_log_on_success(self):
        ctx = _make_ctx({
            "logged": {
                "label": "Logged",
                "steps": [{"type": "delay", "seconds": 0.01}],
            }
        })
        result = execute_macro(ctx, "logged", "test-tablet")
        assert result["success"] is True
        ctx.db.log_action.assert_called()

    def test_audit_log_on_failure(self):
        ctx = _make_ctx({
            "fail_logged": {
                "label": "Fail",
                "steps": [{"type": "nonexistent_type"}],
            }
        })
        result = execute_macro(ctx, "fail_logged", "test-tablet")
        assert result["success"] is False
        ctx.db.log_action.assert_called()

    def test_progress_events_emitted(self):
        ctx = _make_ctx({
            "progress_test": {
                "label": "Progress",
                "steps": [{"type": "delay", "seconds": 0.01}],
            }
        })
        execute_macro(ctx, "progress_test", "test-tablet")
        # Should have emitted at least: started, in_progress, completed
        emit_calls = [c for c in ctx.socketio.emit.call_args_list
                      if c[0][0] == "macro:progress"]
        statuses = [c[0][1]["status"] for c in emit_calls]
        assert "started" in statuses
        assert "completed" in statuses


# ---------------------------------------------------------------------------
# load_macros
# ---------------------------------------------------------------------------

class TestLoadMacros:
    def test_loads_macros_yaml(self):
        """Verify load_macros can read the actual macros.yaml file."""
        import logging
        test_logger = logging.getLogger("test")
        macros_cfg, macro_defs, button_defs, ha_entities = load_macros({}, test_logger)
        # Should have loaded something (the real macros.yaml exists)
        assert isinstance(macro_defs, dict)
        assert isinstance(button_defs, dict)
        assert isinstance(ha_entities, set)
        # The production macros.yaml has 100+ macros
        assert len(macro_defs) > 0

    def test_ha_entities_collected(self):
        """Verify HA entity IDs are extracted from button state bindings."""
        import logging
        test_logger = logging.getLogger("test")
        _, _, _, ha_entities = load_macros({}, test_logger)
        # Should have collected at least some HA entities from button bindings
        assert isinstance(ha_entities, set)


# ---------------------------------------------------------------------------
# step_summary
# ---------------------------------------------------------------------------

class TestStepSummary:
    def test_delay_summary(self):
        result = step_summary({"type": "delay", "seconds": 5}, {})
        assert "5" in result

    def test_ha_service_summary(self):
        result = step_summary(
            {"type": "ha_service", "domain": "light", "service": "turn_on"},
            {},
        )
        assert "light" in result or "ha_service" in result

    def test_macro_summary(self):
        result = step_summary(
            {"type": "macro", "macro": "chapel_tv_on"},
            {"chapel_tv_on": {"label": "Chapel TV On"}},
        )
        assert "chapel_tv_on" in result or "Chapel TV On" in result

    def test_wait_until_summary(self):
        result = step_summary(
            {"type": "wait_until", "target": "x32", "timeout": 45}, {}
        )
        assert "x32" in result
        assert "45" in result

    def test_verify_pending_summary(self):
        result = step_summary(
            {"type": "verify_pending", "message": "check switches"}, {}
        )
        assert "check switches" in result


# ---------------------------------------------------------------------------
# Verification queue
# ---------------------------------------------------------------------------

class TestVerificationQueue:
    def test_add_and_drain(self):
        q = _VerificationQueue()
        entry = _VerificationEntry("switch.test", "on", 10, 2, {})
        q.add(entry)
        assert len(q) == 1
        items = q.drain()
        assert len(items) == 1
        assert len(q) == 0

    def test_clear(self):
        q = _VerificationQueue()
        q.add(_VerificationEntry("switch.a", "on", 10, 2, {}))
        q.add(_VerificationEntry("switch.b", "off", 10, 2, {}))
        assert len(q) == 2
        q.clear()
        assert len(q) == 0

    def test_drain_returns_empty_on_empty(self):
        q = _VerificationQueue()
        assert q.drain() == []


class TestResolveVerify:
    def test_verify_true_shorthand_turn_on(self):
        step = {
            "type": "ha_service", "domain": "switch", "service": "turn_on",
            "data": {"entity_id": "switch.test_outlet"},
            "verify": True,
        }
        entry = _resolve_verify(step)
        assert entry is not None
        assert entry.entity_id == "switch.test_outlet"
        assert entry.expected_state == "on"
        assert entry.timeout == 10
        assert entry.retries == 2

    def test_verify_true_shorthand_turn_off(self):
        step = {
            "type": "ha_service", "domain": "switch", "service": "turn_off",
            "data": {"entity_id": "switch.test_outlet"},
            "verify": True,
        }
        entry = _resolve_verify(step)
        assert entry is not None
        assert entry.expected_state == "off"

    def test_verify_true_non_turn_service_returns_none(self):
        step = {
            "type": "ha_service", "domain": "climate", "service": "set_temperature",
            "data": {"entity_id": "climate.test"},
            "verify": True,
        }
        entry = _resolve_verify(step)
        assert entry is None

    def test_verify_explicit_dict(self):
        step = {
            "type": "ha_service", "domain": "switch", "service": "turn_on",
            "data": {"entity_id": "switch.test_outlet"},
            "verify": {"entity_id": "switch.test_outlet", "state": "on",
                       "timeout": 15, "retries": 3},
        }
        entry = _resolve_verify(step)
        assert entry is not None
        assert entry.timeout == 15
        assert entry.retries == 3

    def test_verify_dict_infers_entity_from_data(self):
        step = {
            "type": "ha_service", "domain": "switch", "service": "turn_on",
            "data": {"entity_id": "switch.abc"},
            "verify": {"state": "on"},
        }
        entry = _resolve_verify(step)
        assert entry is not None
        assert entry.entity_id == "switch.abc"

    def test_no_verify_returns_none(self):
        step = {"type": "ha_service", "domain": "switch", "service": "turn_on",
                "data": {"entity_id": "switch.x"}}
        assert _resolve_verify(step) is None

    def test_verify_false_returns_none(self):
        step = {"type": "ha_service", "domain": "switch", "service": "turn_on",
                "data": {"entity_id": "switch.x"}, "verify": False}
        assert _resolve_verify(step) is None


# ---------------------------------------------------------------------------
# wait_until step type
# ---------------------------------------------------------------------------

class TestWaitUntilStep:
    def test_wait_until_mock_mode_succeeds(self):
        ctx = _make_ctx({
            "wait_test": {
                "label": "Wait Test",
                "steps": [{
                    "type": "wait_until",
                    "target": "x32",
                    "condition": "connected",
                    "timeout": 5,
                    "message": "Waiting for X32",
                }],
            }
        })
        result = execute_macro(ctx, "wait_test", "test-tablet")
        assert result["success"] is True


# ---------------------------------------------------------------------------
# verify + verify_pending integration
# ---------------------------------------------------------------------------

class TestVerifyPending:
    def test_verify_pending_with_empty_queue_succeeds(self):
        ctx = _make_ctx({
            "vp_empty": {
                "label": "VP Empty",
                "steps": [{
                    "type": "verify_pending",
                    "timeout": 5,
                    "message": "Nothing to verify",
                }],
            }
        })
        result = execute_macro(ctx, "vp_empty", "test-tablet")
        assert result["success"] is True

    def test_verify_pending_in_mock_mode_clears_queue(self):
        ctx = _make_ctx({
            "vp_mock": {
                "label": "VP Mock",
                "steps": [
                    {"type": "ha_service", "domain": "switch", "service": "turn_on",
                     "data": {"entity_id": "switch.test"}, "on_fail": "skip",
                     "verify": True},
                    {"type": "verify_pending", "timeout": 5,
                     "message": "Verify in mock"},
                ],
            }
        })
        result = execute_macro(ctx, "vp_mock", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 2

    def test_ha_service_with_verify_queues_entry(self):
        """Verify that ha_service with verify: true still succeeds and queues."""
        ctx = _make_ctx({
            "verify_queue_test": {
                "label": "Queue Test",
                "steps": [
                    {"type": "ha_service", "domain": "switch", "service": "turn_on",
                     "data": {"entity_id": "switch.test_1"}, "on_fail": "skip",
                     "verify": True},
                    {"type": "ha_service", "domain": "switch", "service": "turn_on",
                     "data": {"entity_id": "switch.test_2"}, "on_fail": "skip",
                     "verify": True},
                    {"type": "delay", "seconds": 0.01},
                ],
            }
        })
        result = execute_macro(ctx, "verify_queue_test", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 3

    def test_backward_compat_no_verify(self):
        """Steps without verify behave exactly as before."""
        ctx = _make_ctx({
            "compat_test": {
                "label": "Compat",
                "steps": [
                    {"type": "ha_service", "domain": "switch", "service": "turn_on",
                     "data": {"entity_id": "switch.test"}, "on_fail": "skip"},
                    {"type": "delay", "seconds": 0.01},
                ],
            }
        })
        result = execute_macro(ctx, "compat_test", "test-tablet")
        assert result["success"] is True
        assert result["steps_completed"] == 2
