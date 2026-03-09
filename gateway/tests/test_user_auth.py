"""Tests for user-based authentication — login, session, permissions, actor."""

import json
import os
import re
import sys
import tempfile

import pytest
import yaml
from flask import Flask

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import auth as auth_mod
from auth import check_permission, get_actor, get_tablet_id
from database import Database
from user_module import UserModule


def _reset_rate_limiter():
    """Reset the shared rate limiter between tests to prevent cross-test pollution."""
    auth_mod._auth_limiter._attempts.clear()


def _make_user_auth_app(users_yaml_path=None):
    """Create a Flask app with user auth configured."""
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)

    if not users_yaml_path:
        fd2, users_yaml_path = tempfile.mkstemp(suffix=".yaml")
        os.close(fd2)
        os.unlink(users_yaml_path)

    app = Flask(__name__)
    app.config["SECRET_KEY"] = "test-secret"
    app.config["TESTING"] = True

    class Ctx:
        pass

    ctx = Ctx()
    ctx.app = app
    ctx.db = Database(db_path)
    ctx.allowed_ips = ["192.168.1."]  # Only LAN IPs auto-allowed
    ctx.trusted_proxy_prefixes = []
    ctx.settings_pin = "1234"
    ctx.secure_pin = "5678"
    ctx.remote_auth = {"username": "admin", "password": "legacy123"}  # Legacy fallback
    ctx.session_timeout = 480
    ctx.user_module = UserModule(users_yaml_path)

    from auth import register_auth
    register_auth(ctx)

    return app, ctx, db_path, users_yaml_path


@pytest.fixture
def user_auth_app():
    _reset_rate_limiter()
    app, ctx, db_path, users_path = _make_user_auth_app()
    # Create a test user
    ctx.user_module.create_user("testuser", "Test User", "testpass1", "chapel")
    ctx.user_module.create_user("admin_user", "Admin", "adminpass", "full_access")
    yield app, ctx
    for p in [db_path, users_path]:
        try:
            os.unlink(p)
        except OSError:
            pass


class TestUserLogin:
    def _get_csrf(self, client):
        resp = client.get("/login", environ_base={"REMOTE_ADDR": "10.0.0.1"})
        m = re.search(r'name="csrf_token" value="([^"]+)"', resp.data.decode())
        return m.group(1) if m else ""

    def test_user_login_success(self, user_auth_app):
        app, ctx = user_auth_app
        with app.test_client() as client:
            csrf = self._get_csrf(client)
            resp = client.post("/login",
                               data={"username": "testuser", "password": "testpass1",
                                     "csrf_token": csrf},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 302  # Redirect to /

    def test_user_login_wrong_password(self, user_auth_app):
        app, ctx = user_auth_app
        with app.test_client() as client:
            csrf = self._get_csrf(client)
            resp = client.post("/login",
                               data={"username": "testuser", "password": "wrong",
                                     "csrf_token": csrf},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200
            assert b"Invalid username or password" in resp.data

    def test_user_login_nonexistent_user(self, user_auth_app):
        app, ctx = user_auth_app
        with app.test_client() as client:
            csrf = self._get_csrf(client)
            resp = client.post("/login",
                               data={"username": "nobody", "password": "pass",
                                     "csrf_token": csrf},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200
            assert b"Invalid username or password" in resp.data

    def test_legacy_password_still_works(self, user_auth_app):
        """Legacy single-password login should still work as fallback."""
        app, ctx = user_auth_app
        with app.test_client() as client:
            csrf = self._get_csrf(client)
            resp = client.post("/login",
                               data={"username": "admin", "password": "legacy123",
                                     "csrf_token": csrf},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 302  # Redirect — legacy login succeeded


class TestAuthMe:
    def _login_user(self, client, username="testuser", password="testpass1"):
        csrf = self._get_csrf(client)
        client.post("/login",
                     data={"username": username, "password": password,
                           "csrf_token": csrf},
                     environ_base={"REMOTE_ADDR": "10.0.0.1"})

    def _get_csrf(self, client):
        resp = client.get("/login", environ_base={"REMOTE_ADDR": "10.0.0.1"})
        m = re.search(r'name="csrf_token" value="([^"]+)"', resp.data.decode())
        return m.group(1) if m else ""

    def test_auth_me_user_session(self, user_auth_app):
        app, ctx = user_auth_app

        @app.route("/api/auth/test-me")
        def test_me():
            pass  # auth_me already registered

        with app.test_client() as client:
            self._login_user(client)
            resp = client.get("/api/auth/me", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["type"] == "user"
            assert data["username"] == "testuser"
            assert data["display_name"] == "Test User"
            assert data["role"] == "chapel"

    def test_auth_me_tablet_session(self, user_auth_app):
        app, ctx = user_auth_app
        with app.test_client() as client:
            # LAN IP = auto-authed, no user session
            resp = client.get("/api/auth/me",
                              headers={"X-Tablet-ID": "chapel"},
                              environ_base={"REMOTE_ADDR": "192.168.1.100"})
            assert resp.status_code == 200
            data = resp.get_json()
            assert data["type"] == "tablet"
            assert data["tablet_id"] == "chapel"


class TestUserPermissions:
    def _login_user(self, client, username="testuser", password="testpass1"):
        resp = client.get("/login", environ_base={"REMOTE_ADDR": "10.0.0.1"})
        m = re.search(r'name="csrf_token" value="([^"]+)"', resp.data.decode())
        csrf = m.group(1) if m else ""
        client.post("/login",
                     data={"username": username, "password": password,
                           "csrf_token": csrf},
                     environ_base={"REMOTE_ADDR": "10.0.0.1"})

    def test_user_session_role_checked(self, user_auth_app):
        """User's role from session should be used for permission checks."""
        app, ctx = user_auth_app
        perms = {
            "roles": {
                "chapel": {"permissions": {"stream": True, "settings": False}},
                "full_access": {"permissions": {"stream": True, "settings": True}},
            }
        }

        @app.route("/api/test-perm")
        def test_perm():
            from flask import jsonify
            result = check_permission("user:testuser", "settings", perms)
            if result:
                return result
            return jsonify({"ok": True})

        with app.test_client() as client:
            self._login_user(client)
            # testuser has "chapel" role, which denies "settings"
            resp = client.get("/api/test-perm", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 403

    def test_user_session_allowed_page(self, user_auth_app):
        """User should be allowed to access pages their role permits."""
        app, ctx = user_auth_app
        perms = {
            "roles": {
                "chapel": {"permissions": {"stream": True, "settings": False}},
            }
        }

        @app.route("/api/test-allowed")
        def test_allowed():
            from flask import jsonify
            result = check_permission("user:testuser", "stream", perms)
            if result:
                return result
            return jsonify({"ok": True})

        with app.test_client() as client:
            self._login_user(client)
            resp = client.get("/api/test-allowed", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200


class TestGetActor:
    def _login_user(self, client):
        resp = client.get("/login", environ_base={"REMOTE_ADDR": "10.0.0.1"})
        m = re.search(r'name="csrf_token" value="([^"]+)"', resp.data.decode())
        csrf = m.group(1) if m else ""
        client.post("/login",
                     data={"username": "testuser", "password": "testpass1",
                           "csrf_token": csrf},
                     environ_base={"REMOTE_ADDR": "10.0.0.1"})

    def test_actor_for_user_session(self, user_auth_app):
        app, ctx = user_auth_app

        @app.route("/api/test-actor")
        def test_actor():
            from flask import jsonify
            return jsonify({"actor": get_actor()})

        with app.test_client() as client:
            self._login_user(client)
            resp = client.get("/api/test-actor", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            data = resp.get_json()
            assert data["actor"] == "user:testuser"

    def test_actor_for_tablet(self, user_auth_app):
        app, ctx = user_auth_app

        @app.route("/api/test-actor-tablet")
        def test_actor_tablet():
            from flask import jsonify
            return jsonify({"actor": get_actor()})

        with app.test_client() as client:
            resp = client.get("/api/test-actor-tablet",
                              headers={"X-Tablet-ID": "chapel"},
                              environ_base={"REMOTE_ADDR": "192.168.1.100"})
            data = resp.get_json()
            assert data["actor"] == "tablet:chapel"


class TestChangeOwnPassword:
    def _login_user(self, client, username="testuser", password="testpass1"):
        resp = client.get("/login", environ_base={"REMOTE_ADDR": "10.0.0.1"})
        m = re.search(r'name="csrf_token" value="([^"]+)"', resp.data.decode())
        csrf = m.group(1) if m else ""
        client.post("/login",
                     data={"username": username, "password": password,
                           "csrf_token": csrf},
                     environ_base={"REMOTE_ADDR": "10.0.0.1"})

    def test_change_password_success(self, user_auth_app):
        app, ctx = user_auth_app
        import json

        @app.route("/api/users/me/password", methods=["POST"])
        def _change_pw():
            from flask import session as flask_session
            username = flask_session.get("user")
            if not username:
                return {"error": "Not logged in"}, 403
            data = request.get_json(silent=True) or {}
            if not ctx.user_module.authenticate(username, data.get("current_password", "")):
                return {"error": "Current password is incorrect"}, 401
            try:
                ctx.user_module.reset_password(username, data.get("new_password", ""))
                return {"success": True}
            except ValueError as e:
                return {"error": str(e)}, 400

        with app.test_client() as client:
            self._login_user(client)
            from flask import request
            resp = client.post("/api/users/me/password",
                               json={"current_password": "testpass1", "new_password": "newpass99"},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200
            # Verify new password works
            assert ctx.user_module.authenticate("testuser", "newpass99") is not None
            # Old password no longer works
            assert ctx.user_module.authenticate("testuser", "testpass1") is None

    def test_change_password_wrong_current(self, user_auth_app):
        app, ctx = user_auth_app

        @app.route("/api/users/me/password-test2", methods=["POST"])
        def _change_pw2():
            from flask import session as flask_session
            username = flask_session.get("user")
            if not username:
                return {"error": "Not logged in"}, 403
            data = request.get_json(silent=True) or {}
            if not ctx.user_module.authenticate(username, data.get("current_password", "")):
                return {"error": "Current password is incorrect"}, 401
            return {"success": True}

        with app.test_client() as client:
            self._login_user(client)
            from flask import request
            resp = client.post("/api/users/me/password-test2",
                               json={"current_password": "wrongpass", "new_password": "newpass99"},
                               environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 401


class TestSessionRevocation:
    def _login_user(self, client, username="testuser", password="testpass1"):
        resp = client.get("/login", environ_base={"REMOTE_ADDR": "10.0.0.1"})
        m = re.search(r'name="csrf_token" value="([^"]+)"', resp.data.decode())
        csrf = m.group(1) if m else ""
        client.post("/login",
                     data={"username": username, "password": password,
                           "csrf_token": csrf},
                     environ_base={"REMOTE_ADDR": "10.0.0.1"})

    def test_revoke_invalidates_session(self, user_auth_app):
        """After revoking a user, their next request should be unauthenticated."""
        app, ctx = user_auth_app
        from auth import revoke_user_sessions

        with app.test_client() as client:
            self._login_user(client)
            # Verify session works
            resp = client.get("/api/auth/me", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.get_json()["type"] == "user"

            # Revoke user sessions
            revoke_user_sessions("testuser")

            # Next request should fail auth — redirects to login for non-API
            resp = client.get("/api/auth/me", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            # After revocation, the session is cleared so this is now unauthenticated
            assert resp.status_code == 401 or resp.status_code == 302

    def test_revoke_does_not_affect_other_users(self, user_auth_app):
        """Revoking one user should not affect other users."""
        app, ctx = user_auth_app
        from auth import revoke_user_sessions

        with app.test_client() as client:
            self._login_user(client, "admin_user", "adminpass")
            revoke_user_sessions("testuser")  # Revoke a different user
            resp = client.get("/api/auth/me", environ_base={"REMOTE_ADDR": "10.0.0.1"})
            assert resp.status_code == 200
            assert resp.get_json()["username"] == "admin_user"


class TestDistinctActors:
    def test_get_distinct_actors(self, user_auth_app):
        app, ctx = user_auth_app
        db = ctx.db
        db.log_action("chapel", "test1", "t1", actor="user:john")
        db.log_action("main", "test2", "t2", actor="tablet:main")
        db.log_action("chapel", "test3", "t3", actor="user:john")  # duplicate
        actors = db.get_distinct_actors()
        assert "user:john" in actors
        assert "tablet:main" in actors
        assert len(actors) == 2  # no duplicates


class TestAuditLogActor:
    def test_actor_column_in_logs(self, user_auth_app):
        app, ctx = user_auth_app
        db = ctx.db
        db.log_action("chapel", "test", "target", actor="user:john")
        logs = db.get_recent_logs(1)
        assert len(logs) == 1
        assert logs[0]["actor"] == "user:john"

    def test_auto_actor_without_explicit(self, user_auth_app):
        app, ctx = user_auth_app
        db = ctx.db
        # Outside request context, auto_actor falls back to tablet_id
        db.log_action("chapel", "test", "target")
        logs = db.get_recent_logs(1)
        assert logs[0]["actor"] == "tablet:chapel"


# ---------------------------------------------------------------------------
# Role CRUD API Tests
# ---------------------------------------------------------------------------

def _make_role_api_app():
    """Create a Flask app with auth + api routes registered for role CRUD tests."""
    import threading
    fd, db_path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    fd2, users_path = tempfile.mkstemp(suffix=".yaml")
    os.close(fd2)
    os.unlink(users_path)
    fd3, perms_path = tempfile.mkstemp(suffix=".json")
    os.close(fd3)

    perms_data = {
        "roles": {
            "full_access": {"displayName": "Full Access", "permissions": {
                "home": True, "main": True, "chapel": True, "social": True,
                "gym": True, "confroom": True, "stream": True, "source": True,
                "security": True, "settings": True,
            }},
            "chapel": {"displayName": "Chapel", "permissions": {
                "home": True, "main": False, "chapel": True, "social": False,
                "gym": False, "confroom": False, "stream": True, "source": True,
                "security": False, "settings": True,
            }},
        },
        "locations": {},
        "defaultRole": "full_access",
    }
    with open(perms_path, "w") as f:
        json.dump(perms_data, f)

    app = Flask(__name__, static_folder=None)
    app.config["SECRET_KEY"] = "test-secret"
    app.config["TESTING"] = True

    from polling import StateCache, PollerWatchdog

    class Ctx:
        pass

    ctx = Ctx()
    ctx.app = app
    ctx.socketio = type("FakeSocketIO", (), {"emit": lambda *a, **kw: None})()
    ctx.db = Database(db_path)
    ctx.cfg = {
        "home_assistant": {"url": "", "token": ""},
        "middleware": {}, "camlytics": {}, "polling": {},
        "projectors": {}, "ptz_cameras": {},
        "wattbox": {"ip": "", "username": "", "password": ""},
    }
    ctx.mock_mode = True
    ctx.config_path = ""
    ctx.state_cache = StateCache()
    ctx.watchdog = PollerWatchdog()
    ctx.verbose_logging = threading.Event()
    ctx.camlytics_buffers = {"communion": 0, "occupancy": 0, "enter": 0}
    ctx.camlytics_lock = threading.Lock()
    ctx.ha_device_cache = {"cameras": [], "locks": [], "ready": True}
    ctx.ha_cache_lock = threading.Lock()
    ctx.sid_to_tablet = {}
    ctx.sid_connect_time = {}
    ctx.sid_lock = threading.Lock()
    ctx.permissions_data = perms_data
    ctx.permissions_path = perms_path
    ctx.devices_data = {}
    ctx.settings_data = {"version": "test"}
    ctx.static_dir = tempfile.mkdtemp()
    ctx.known_location_slugs = set()

    from macro_engine import load_macros
    import logging
    _, ctx.macro_defs, ctx.button_defs, ctx.ha_state_entities = load_macros({}, logging.getLogger("test"))
    ctx.macros_cfg = {}
    ctx.x32 = None
    ctx.moip = None
    ctx.obs = None
    ctx.health = None
    ctx.occupancy = None

    from announcement_module import AnnouncementModule
    ctx.announcements = AnnouncementModule(ctx.cfg, logging.getLogger("test"), ctx=ctx)

    ctx.allowed_ips = ["127.0.0.1"]
    ctx.trusted_proxy_prefixes = []
    ctx.settings_pin = "1234"
    ctx.secure_pin = "5678"
    ctx.remote_auth = {}
    ctx.session_timeout = 480
    ctx.user_module = UserModule(users_path)

    from auth import register_auth
    from api_routes import register_api_routes
    register_auth(ctx)
    register_api_routes(ctx)

    with open(os.path.join(ctx.static_dir, "index.html"), "w") as f:
        f.write("<html><body>test</body></html>")

    return app, ctx, [db_path, users_path, perms_path]


@pytest.fixture
def role_api():
    _reset_rate_limiter()
    app, ctx, paths = _make_role_api_app()
    yield app, ctx
    for p in paths:
        try:
            os.unlink(p)
        except OSError:
            pass


class TestRoleCRUD:
    def test_list_roles(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.get("/api/roles")
            data = resp.get_json()
            assert resp.status_code == 200
            assert len(data["roles"]) == 2
            assert "pages" in data

    def test_create_role(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.post("/api/roles",
                               json={"key": "test_role", "displayName": "Test Role",
                                     "permissions": {"home": True, "main": True}},
                               content_type="application/json")
            assert resp.status_code == 201
            # Verify persisted to disk
            with open(ctx.permissions_path) as f:
                saved = json.load(f)
            assert "test_role" in saved["roles"]
            assert saved["roles"]["test_role"]["displayName"] == "Test Role"

    def test_create_duplicate_role(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.post("/api/roles",
                               json={"key": "chapel", "displayName": "Dup"},
                               content_type="application/json")
            assert resp.status_code == 400
            assert "already exists" in resp.get_json()["error"]

    def test_update_role(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.put("/api/roles/chapel",
                              json={"displayName": "Chapel Updated",
                                    "permissions": {"gym": True}},
                              content_type="application/json")
            assert resp.status_code == 200
            assert ctx.permissions_data["roles"]["chapel"]["displayName"] == "Chapel Updated"
            assert ctx.permissions_data["roles"]["chapel"]["permissions"]["gym"] is True

    def test_update_nonexistent_role(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.put("/api/roles/nope",
                              json={"displayName": "X"},
                              content_type="application/json")
            assert resp.status_code == 404

    def test_delete_role(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.delete("/api/roles/chapel")
            assert resp.status_code == 200
            assert "chapel" not in ctx.permissions_data["roles"]

    def test_delete_full_access_forbidden(self, role_api):
        app, ctx = role_api
        with app.test_client() as client:
            resp = client.delete("/api/roles/full_access")
            assert resp.status_code == 400
            assert "Cannot delete" in resp.get_json()["error"]

    def test_delete_role_in_use_by_user(self, role_api):
        app, ctx = role_api
        ctx.user_module.create_user("john", "John", "pass1234", "chapel")
        with app.test_client() as client:
            resp = client.delete("/api/roles/chapel")
            assert resp.status_code == 400
            assert "assigned to user" in resp.get_json()["error"]
