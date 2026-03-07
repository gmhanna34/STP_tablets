"""Tests for CircuitBreaker — failure tracking with state transitions."""

import time

from polling import CircuitBreaker


class TestCircuitBreaker:
    def test_initial_state_is_closed(self):
        cb = CircuitBreaker(threshold=3, recovery_timeout=10)
        assert cb.state == "closed"
        assert cb.allow_request() is True

    def test_stays_closed_below_threshold(self):
        cb = CircuitBreaker(threshold=5)
        for _ in range(4):
            cb.record_failure()
        assert cb.state == "closed"
        assert cb.allow_request() is True

    def test_opens_at_threshold(self):
        cb = CircuitBreaker(threshold=3)
        for _ in range(3):
            cb.record_failure()
        assert cb.state == "open"
        assert cb.allow_request() is False

    def test_success_resets_to_closed(self):
        cb = CircuitBreaker(threshold=2)
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "open"
        cb.record_success()
        assert cb.state == "closed"
        assert cb.allow_request() is True

    def test_success_resets_fail_count(self):
        cb = CircuitBreaker(threshold=3)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        # After success, fail count is reset, so 2 more failures shouldn't open
        cb.record_failure()
        cb.record_failure()
        assert cb.state == "closed"

    def test_half_open_after_recovery_timeout(self):
        cb = CircuitBreaker(threshold=1, recovery_timeout=0.1)
        cb.record_failure()
        assert cb.state == "open"
        time.sleep(0.15)
        assert cb.state == "half-open"
        assert cb.allow_request() is True

    def test_status_returns_dict(self):
        cb = CircuitBreaker(threshold=5, recovery_timeout=30)
        cb.record_failure()
        cb.record_failure()
        s = cb.status()
        assert s["state"] == "closed"
        assert s["fail_count"] == 2
        assert s["threshold"] == 5

    def test_status_shows_open_state(self):
        cb = CircuitBreaker(threshold=2)
        cb.record_failure()
        cb.record_failure()
        s = cb.status()
        assert s["state"] == "open"
        assert s["fail_count"] == 2
