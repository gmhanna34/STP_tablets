"""Tests for auth module — IP allowlist, PIN verification, sessions, permissions."""

import os
import sys
import time

import pytest
from flask import Flask

# Ensure gateway/ is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from auth import check_permission, get_tablet_id, get_tablet_role


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _make_app_and_ctx(allowed_ips=None, settings_pin="1234", secure_pin="5678",
                      remote_auth=None, session_timeout=480):
    """Create a minimal Flask app with auth registered."""
    from database import Database
    import tempfile

    app = Flask(__name__)
    app.config["SECRET_KEY"] = "test-secret"
    app.config["TESTING"] = True

    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    class Ctx:
        pass

    ctx = Ctx()
    ctx.app = app
    ctx.db = Database(db_path)
    ctx.allowed_ips = allowed_ips or ["127.0.0.1", "192.168.1."]
    ctx.settings_pin = settings_pin
    ctx.secure_pin = secure_pin
    ctx.remote_auth = remote_auth or {}
    ctx.session_timeout = session_timeout

    from auth import register_auth
    register_auth(ctx)

    return app, ctx, db_path


@pytest.fixture
def auth_app():
    app, ctx, db_path = _make_app_and_ctx()
    yield app, ctx
    try:
        os.unlink(db_path)
    except OSError:
        pass


@pytest.fixture
def remote_auth_app():
    app, ctx, db_path = _make_app_and_ctx(
        allowed_ips=["192.168.1."],
        remote_auth={"username": "admin", "password": "secret123"},
    )
    yield app, ctx
    try:
        os.unlink(db_path)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# get_tablet_id tests
# ---------------------------------------------------------------------------

class TestGetTabletId:
    def test_from_header(self, auth_app):
        app, ctx = auth_app
        with app.test_request_context(headers={"X-Tablet-ID": "chapel"}):
            assert get_tablet_id() == "chapel"

    def test_from_query_param(self, auth_app):
        app, ctx = auth_app
        with app.test_request_context("/?tablet=lobby"):
            assert get_tablet_id() == "lobby"

    def test_defaults_to_unknown(self, auth_app):
        app, ctx = auth_app
        with app.test_request_context():
            assert get_tablet_id() == "Unknown"

    def test_header_takes_precedence(self, auth_app):
        app, ctx = auth_app
        with app.test_request_context(
            "/?tablet=lobby",
            headers={"X-Tablet-ID": "chapel"},
        ):
            assert get_tablet_id() == "chapel"


# ---------------------------------------------------------------------------
# get_tablet_role tests
# ---------------------------------------------------------------------------

class TestGetTabletRole:
    def test_returns_role_from_header(self, auth_app):
        app, ctx = auth_app
        perms = {"roles": {"view_only": {"permissions": {}}}, "defaultRole": "full_access"}
        with app.test_request_context(headers={"X-Tablet-Role": "view_only"}):
            assert get_tablet_role(perms) == "view_only"

    def test_returns_default_when_role_unknown(self, auth_app):
        app, ctx = auth_app
        perms = {"roles": {"view_only": {}}, "defaultRole": "full_access"}
        with app.test_request_context(headers={"X-Tablet-Role": "nonexistent"}):
            assert get_tablet_role(perms) == "full_access"

    def test_returns_default_when_no_header(self, auth_app):
        app, ctx = auth_app
        perms = {"roles": {}, "defaultRole": "full_access"}
        with app.test_request_context():
            assert get_tablet_role(perms) == "full_access"


# ---------------------------------------------------------------------------
# check_permission tests
# ---------------------------------------------------------------------------

class TestCheckPermission:
    def test_allows_when_role_has_permission(self, auth_app):
        app, ctx = auth_app
        perms = {"roles": {"full": {"permissions": {"stream": True, "settings": True}}}}
        with app.test_request_context(headers={"X-Tablet-Role": "full"}):
            result = check_permission("tablet1", "stream", perms)
            assert result is None  # None = allowed

    def test_denies_when_permission_is_false(self, auth_app):
        app, ctx = auth_app
        perms = {"roles": {"view_only": {"permissions": {"settings": False}}}}
        with app.test_request_context(headers={"X-Tablet-Role": "view_only"}):
            result = check_permission("tablet1", "settings", perms)
            assert result is not None
            resp, status = result
            assert status == 403

    def test_fail_open_for_unknown_tablet(self, auth_app):
        """Current behavior: unknown tablets are allowed (fail-open)."""
        app, ctx = auth_app
        perms = {"roles": {"view_only": {"permissions": {"settings": False}}}}
        with app.test_request_context():
            # No X-Tablet-Role header, unknown tablet
            result = check_permission("unknown_tablet", "settings", perms)
            # Currently fail-open — returns None (allowed)
            assert result is None

    def test_backwards_compat_location_key(self, auth_app):
        app, ctx = auth_app
        perms = {
            "roles": {},
            "locations": {
                "Tablet_Chapel": {
                    "permissions": {"settings": False, "stream": True}
                }
            },
        }
        with app.test_request_context():
            # Denied page
            result = check_permission("Tablet_Chapel", "settings", perms)
            assert result is not None
            _, status = result
            assert status == 403

            # Allowed page
            result = check_permission("Tablet_Chapel", "stream", perms)
            assert result is None


# ---------------------------------------------------------------------------
# PIN verification tests
# ---------------------------------------------------------------------------

class TestPinVerification:
    def test_correct_settings_pin(self, auth_app):
        app, ctx = auth_app
        with app.test_client() as client:
            resp = client.post("/api/auth/verify-pin",
                               json={"pin": "1234"},
                               environ_base={"REMOTE_ADDR": "127.0.0.1"})
            assert resp.status_code == 200
            assert resp.get_json()["success"] is True

    def test_wrong_settings_pin(self, auth_app):
        app, ctx = auth_app
        with app.test_client() as client:
            resp = client.post("/api/auth/verify-pin",
                               json={"pin": "0000"},
                               environ_base={"REMOTE_ADDR": "127.0.0.1"})
            assert resp.status_code == 401
            assert resp.get_json()["success"] is False

    def test_correct_secure_pin(self, auth_app):
        app, ctx = auth_app
        with app.test_client() as client:
            resp = client.post("/api/auth/verify-secure-pin",
                               json={"pin": "5678"},
                               environ_base={"REMOTE_ADDR": "127.0.0.1"})
            assert resp.status_code == 200
            assert resp.get_json()["success"] is True

    def test_wrong_secure_pin(self, auth_app):
        app, ctx = auth_app
        with app.test_client() as client:
            resp = client.post("/api/auth/verify-secure-pin",
                               json={"pin": "0000"},
                               environ_base={"REMOTE_ADDR": "127.0.0.1"})
            assert resp.status_code == 401

    def test_secure_pin_not_configured(self):
        app, ctx, db_path = _make_app_and_ctx(secure_pin="")
        try:
            with app.test_client() as client:
                resp = client.post("/api/auth/verify-secure-pin",
                                   json={"pin": "anything"},
                                   environ_base={"REMOTE_ADDR": "127.0.0.1"})
                assert resp.status_code == 503
        finally:
            try:
                os.unlink(db_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# IP allowlist / auth middleware tests
# ---------------------------------------------------------------------------

class TestAuthMiddleware:
    def test_allowed_ip_bypasses_auth(self, auth_app):
        app, ctx = auth_app
        # Add a dummy route to test
        @app.route("/api/test-endpoint")
        def test_endpoint():
            return "ok"

        with app.test_client() as client:
            resp = client.get("/api/test-endpoint",
                              environ_base={"REMOTE_ADDR": "127.0.0.1"})
            assert resp.status_code == 200

    def test_blocked_ip_without_remote_auth(self, auth_app):
        app, ctx = auth_app
        @app.route("/api/test-endpoint")
        def test_endpoint():
            return "ok"

        with app.test_client() as client:
            resp = client.get("/api/test-endpoint",
                              environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 403

    def test_remote_auth_redirects_browser(self, remote_auth_app):
        app, ctx = remote_auth_app
        @app.route("/test-page")
        def test_page():
            return "page content"

        with app.test_client() as client:
            resp = client.get("/test-page",
                              environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 302
            assert "/login" in resp.headers["Location"]

    def test_remote_auth_returns_401_for_api(self, remote_auth_app):
        app, ctx = remote_auth_app
        @app.route("/api/test")
        def test_api():
            return "data"

        with app.test_client() as client:
            resp = client.get("/api/test",
                              environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 401

    def test_login_with_correct_password(self, remote_auth_app):
        app, ctx = remote_auth_app
        with app.test_client() as client:
            resp = client.post("/login",
                               data={"username": "admin", "password": "secret123"},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 302  # Redirect to /

    def test_login_with_wrong_password(self, remote_auth_app):
        app, ctx = remote_auth_app
        with app.test_client() as client:
            resp = client.post("/login",
                               data={"username": "admin", "password": "wrong"},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200  # Re-renders login page
            assert b"Invalid password" in resp.data

    def test_logout_clears_session(self, remote_auth_app):
        app, ctx = remote_auth_app
        with app.test_client() as client:
            # Login first
            client.post("/login",
                         data={"username": "admin", "password": "secret123"},
                         environ_base={"REMOTE_ADDR": "10.0.0.1"})
            # Logout
            resp = client.get("/logout",
                              environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 302
            assert "/login" in resp.headers["Location"]

    def test_socket_io_path_bypasses_auth(self, auth_app):
        app, ctx = auth_app
        with app.test_client() as client:
            # Socket.IO paths should not be blocked
            resp = client.get("/socket.io/?EIO=4&transport=polling",
                              environ_base={"REMOTE_ADDR": "10.0.0.1"})
            # Won't be 403 — might be 400 (no SocketIO server) but not auth-blocked
            assert resp.status_code != 403
