"""Tests for StateCache — thread-safe state storage with volatile field stripping."""

import threading

from polling import StateCache


class TestStateCache:
    def test_get_returns_none_for_missing_key(self):
        cache = StateCache()
        assert cache.get("nonexistent") is None

    def test_set_returns_true_on_first_insert(self):
        cache = StateCache()
        assert cache.set("x32", {"channels": {}}) is True

    def test_set_returns_false_when_unchanged(self):
        cache = StateCache()
        data = {"channels": {"1": {"muted": False}}}
        cache.set("x32", data)
        assert cache.set("x32", data) is False

    def test_set_returns_true_when_data_changes(self):
        cache = StateCache()
        cache.set("x32", {"channels": {"1": {"muted": False}}})
        assert cache.set("x32", {"channels": {"1": {"muted": True}}}) is True

    def test_volatile_fields_ignored_in_comparison(self):
        cache = StateCache()
        cache.set("x32", {"channels": {}, "age_seconds": 5})
        # Only age_seconds changed — should NOT be treated as a real change
        assert cache.set("x32", {"channels": {}, "age_seconds": 10}) is False

    def test_volatile_stream_timecode_ignored(self):
        cache = StateCache()
        cache.set("obs", {"streaming": True, "stream_timecode": "00:00:01"})
        assert cache.set("obs", {"streaming": True, "stream_timecode": "00:00:06"}) is False

    def test_volatile_plus_real_change_detected(self):
        cache = StateCache()
        cache.set("obs", {"streaming": True, "stream_timecode": "00:00:01"})
        assert cache.set("obs", {"streaming": False, "stream_timecode": "00:00:06"}) is True

    def test_get_all_returns_copy(self):
        cache = StateCache()
        cache.set("a", 1)
        cache.set("b", 2)
        all_state = cache.get_all()
        assert all_state == {"a": 1, "b": 2}
        # Mutating the returned dict doesn't affect cache
        all_state["c"] = 3
        assert cache.get("c") is None

    def test_get_returns_stored_value(self):
        cache = StateCache()
        cache.set("moip", {"rx1": "tx2"})
        assert cache.get("moip") == {"rx1": "tx2"}

    def test_non_dict_values_work(self):
        cache = StateCache()
        assert cache.set("count", 42) is True
        assert cache.set("count", 42) is False
        assert cache.set("count", 43) is True

    def test_thread_safety(self):
        """Concurrent set/get operations should not raise."""
        cache = StateCache()
        errors = []

        def writer(key, n):
            try:
                for i in range(100):
                    cache.set(key, {"val": i})
            except Exception as e:
                errors.append(e)

        def reader(key, n):
            try:
                for _ in range(100):
                    cache.get(key)
                    cache.get_all()
            except Exception as e:
                errors.append(e)

        threads = []
        for k in ("a", "b", "c"):
            threads.append(threading.Thread(target=writer, args=(k, 100)))
            threads.append(threading.Thread(target=reader, args=(k, 100)))

        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=5)

        assert errors == []

    def test_all_volatile_keys_ignored(self):
        """Verify every key in VOLATILE_KEYS is stripped."""
        cache = StateCache()
        base = {"real_field": "value"}
        volatile_data = dict(base)
        for key in StateCache.VOLATILE_KEYS:
            volatile_data[key] = "something"

        cache.set("test", base)
        # Adding only volatile fields shouldn't trigger change
        assert cache.set("test", volatile_data) is False
