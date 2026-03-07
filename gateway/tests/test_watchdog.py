"""Tests for PollerWatchdog — heartbeat tracking and staleness detection."""

import time

from polling import PollerWatchdog


class TestPollerWatchdog:
    def test_register_and_heartbeat(self):
        wd = PollerWatchdog()
        wd.register("x32", interval=5)
        status = wd.status()
        assert "x32" in status
        assert status["x32"]["stale"] is False

    def test_stale_detection(self):
        wd = PollerWatchdog()
        wd.register("test_poller", interval=0.01)
        time.sleep(0.05)  # 5x the interval → stale
        status = wd.status()
        # Stale threshold is interval * 3
        assert status["test_poller"]["stale"] is True

    def test_heartbeat_resets_staleness(self):
        wd = PollerWatchdog()
        wd.register("test_poller", interval=0.01)
        time.sleep(0.05)
        wd.heartbeat("test_poller")
        status = wd.status()
        assert status["test_poller"]["stale"] is False

    def test_breaker_per_poller(self):
        wd = PollerWatchdog()
        wd.register("x32", interval=5)
        wd.register("moip", interval=10)
        cb_x32 = wd.breaker("x32")
        cb_moip = wd.breaker("moip")
        assert cb_x32 is not None
        assert cb_moip is not None
        assert cb_x32 is not cb_moip

    def test_breaker_returns_none_for_unknown(self):
        wd = PollerWatchdog()
        assert wd.breaker("unknown") is None

    def test_status_includes_circuit_info(self):
        wd = PollerWatchdog()
        wd.register("obs", interval=3)
        status = wd.status()
        assert status["obs"]["circuit"] is not None
        assert status["obs"]["circuit"]["state"] == "closed"

    def test_multiple_pollers(self):
        wd = PollerWatchdog()
        for name in ("x32", "moip", "obs", "projectors", "ha"):
            wd.register(name, interval=5)
        status = wd.status()
        assert len(status) == 5
        for name in ("x32", "moip", "obs", "projectors", "ha"):
            assert name in status
