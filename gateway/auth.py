"""IP allowlist, PIN verification, sessions, CSRF, rate limiting, and permission enforcement."""

from __future__ import annotations

import logging
import os
import time
from collections import defaultdict

from flask import Response, jsonify, redirect, request, session, url_for

logger = logging.getLogger("stp-gateway")


# ---------------------------------------------------------------------------
# Request-scoped helpers (use Flask's request context)
# ---------------------------------------------------------------------------

def get_tablet_id() -> str:
    """Extract the tablet identifier from the current request."""
    return (
        request.headers.get("X-Tablet-ID")
        or request.args.get("tablet")
        or "Unknown"
    )


def get_tablet_role(permissions_data: dict) -> str:
    """Get the tablet's current role from header, falling back to defaultRole."""
    role = request.headers.get("X-Tablet-Role", "")
    if role and role in (permissions_data.get("roles") or {}):
        return role
    return permissions_data.get("defaultRole", "full_access")


def check_permission(tablet_id: str, required_page: str, permissions_data: dict):
    """Returns an error response tuple if permission denied, None if OK.

    Uses the X-Tablet-Role header (new) or falls back to looking up
    the tablet_id as an old-style location key for backwards compat.
    """
    roles = permissions_data.get("roles", {})

    # New path: check X-Tablet-Role header
    role_key = request.headers.get("X-Tablet-Role", "")
    if role_key and role_key in roles:
        perms = roles[role_key].get("permissions", {})
        if perms.get(required_page) is False:
            return jsonify({"error": "Permission denied", "page": required_page}), 403
        return None

    # Backwards compat: old-style location key (e.g. Tablet_Mainchurch)
    old_locations = permissions_data.get("locations", {})
    loc = old_locations.get(tablet_id) if isinstance(old_locations.get(tablet_id, {}), dict) else None
    if loc and "permissions" in loc:
        perms = loc.get("permissions", {})
        if perms.get(required_page) is False:
            return jsonify({"error": "Permission denied", "page": required_page}), 403
        return None

    # Unknown tablet / no role header — allow (fail-open) for now
    logger.debug(f"Permission check: no recognised role for tablet={tablet_id}, "
                 f"role_header={role_key!r}, page={required_page} — allowing (fail-open)")
    return None




# ---------------------------------------------------------------------------
# CSRF token helpers
# ---------------------------------------------------------------------------

def _generate_csrf_token() -> str:
    """Generate and store a CSRF token in the session."""
    token = os.urandom(32).hex()
    session["csrf_token"] = token
    return token


def _validate_csrf_token() -> bool:
    """Check if the submitted CSRF token matches the session token."""
    expected = session.get("csrf_token", "")
    submitted = request.form.get("csrf_token", "")
    if not expected or not submitted:
        return False
    return expected == submitted


# ---------------------------------------------------------------------------
# Rate limiter (in-memory, per-IP)
# ---------------------------------------------------------------------------

class _RateLimiter:
    """Simple in-memory sliding-window rate limiter."""

    def __init__(self, max_attempts: int = 5, window_seconds: int = 60):
        self._max = max_attempts
        self._window = window_seconds
        self._attempts: dict = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        cutoff = now - self._window
        self._attempts[key] = [t for t in self._attempts[key] if t > cutoff]
        if len(self._attempts[key]) >= self._max:
            return False
        self._attempts[key].append(now)
        return True

    def remaining(self, key: str) -> int:
        now = time.time()
        cutoff = now - self._window
        recent = [t for t in self._attempts.get(key, []) if t > cutoff]
        return max(0, self._max - len(recent))


# Shared rate limiter for auth endpoints (5 attempts per 60s per IP)
_auth_limiter = _RateLimiter(max_attempts=5, window_seconds=60)

# ---------------------------------------------------------------------------
# LOGIN HTML
# ---------------------------------------------------------------------------

LOGIN_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — St. Paul Control Panel</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/icon?family=Material+Icons">
  <style>
    :root {
      --sp-dark: #343B3D;
      --sp-light: #B4B0A5;
      --sp-bg: #f4f3f1;
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--sp-bg);
      color: var(--sp-dark);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    nav {
      background: var(--sp-dark);
      color: #fff;
      padding: 12px 20px;
      font-size: 18px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    nav img { height: 28px; width: auto; border-radius: 50%; }
    .container {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #fff;
      border-radius: 10px;
      padding: 32px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    .card h1 { font-size: 22px; margin-bottom: 8px; }
    .card .hint {
      font-size: 14px;
      color: #7b7f75;
      margin-bottom: 20px;
      line-height: 1.5;
    }
    .alert {
      background: #f8d7da;
      color: #842029;
      border: 1px solid #f5c2c7;
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 14px;
      margin-bottom: 16px;
    }
    label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      font-size: 16px;
      border: 1px solid #d1cdc4;
      border-radius: 6px;
      background: #fff;
      color: var(--sp-dark);
      margin-bottom: 16px;
      font-family: inherit;
    }
    input:focus {
      outline: none;
      border-color: var(--sp-dark);
      box-shadow: 0 0 0 2px rgba(52,59,61,0.15);
    }
    button[type="submit"] {
      width: 100%;
      padding: 12px;
      font-size: 16px;
      font-weight: 600;
      background: var(--sp-dark);
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-family: inherit;
    }
    button[type="submit"]:hover { filter: brightness(1.15); }
    .tip {
      font-size: 13px;
      color: #7b7f75;
      margin-top: 16px;
      line-height: 1.5;
    }
    .tip code {
      background: #eceae6;
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <nav>
    <img src="/assets/images/church-seal.svg" alt="" onerror="this.style.display='none'">
    <span>St. Paul Control Panel</span>
  </nav>
  <div class="container">
    <div class="card">
      <h1>Sign in</h1>
      <p class="hint">
        This network is not on the trusted IP whitelist.<br>
        Enter your credentials to continue.
      </p>
      {{ERROR}}
      <form method="post" autocomplete="on">
        <input type="hidden" name="csrf_token" value="{{CSRF_TOKEN}}">
        <label for="username">Username</label>
        <input type="text" id="username" name="username"
               autocomplete="username" autocapitalize="none" required>
        <label for="password">Password</label>
        <input type="password" id="password" name="password"
               autocomplete="current-password" required>
        <button type="submit">Login</button>
      </form>
      <div class="tip">
        Tip: add your home IP prefix to <code>allowed_ips</code> in config.yaml
        for passwordless access.
      </div>
    </div>
  </div>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_auth(ctx):
    """Register auth middleware, login/logout routes, and PIN endpoints."""
    app = ctx.app
    db = ctx.db

    allowed_ips = ctx.allowed_ips
    settings_pin = ctx.settings_pin
    secure_pin = ctx.secure_pin
    remote_auth = ctx.remote_auth
    session_timeout = ctx.session_timeout

    def _ip_allowed(ip: str) -> bool:
        return any(ip.startswith(pfx) for pfx in allowed_ips)

    def _session_is_authed() -> bool:
        exp = session.get("auth_exp")
        if not exp:
            return False
        if time.time() > float(exp):
            session.clear()
            return False
        # Refresh expiry on activity (idle timeout)
        session["auth_exp"] = time.time() + session_timeout * 60
        return bool(session.get("authed"))

    def _is_authed() -> bool:
        return _ip_allowed(request.remote_addr or "") or _session_is_authed()

    # Store on ctx so other modules can use it
    ctx._is_authed = _is_authed

    @app.before_request
    def security_check():
        # Skip auth for SocketIO, login page, and its static assets
        if request.path.startswith("/socket.io"):
            return None
        if request.path in ("/login", "/logout"):
            return None
        # Allow readiness probe without auth
        if request.path == "/api/readiness":
            return None
        # Allow TTS audio serving without auth (WiiM speaker fetches these directly)
        if request.path.startswith("/api/tts/audio/"):
            return None

        if _is_authed():
            return None

        client_ip = request.remote_addr or ""

        # If remote_auth is configured, redirect browsers / return 401 for API
        if remote_auth.get("password"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required"}), 401
            logger.info(f"AUTH_REDIRECT ip={client_ip} path={request.path}")
            return redirect(url_for("login_page", next=request.path))

        logger.warning(f"BLOCKED ip={client_ip} path={request.path}")
        return jsonify({"error": "Unauthorized - Invalid IP"}), 403

    @app.after_request
    def log_response(resp):
        # Don't log static file requests, login page, or socket.io polling
        if request.path.startswith("/socket.io") or request.path == "/login":
            return resp
        if not request.path.startswith("/api/"):
            return resp
        client_ip = request.remote_addr or ""
        logger.info(
            f"[{get_tablet_id()}] ip={client_ip} {request.method} {request.path} -> {resp.status_code}"
        )
        return resp

    # ---- Login / Logout ----

    @app.route("/login", methods=["GET", "POST"])
    def login_page():
        # Already authenticated — go straight to the app
        if _is_authed():
            return redirect(request.args.get("next") or "/")

        error_html = ""
        if request.method == "POST":
            client_ip = request.remote_addr or "unknown"
            # Rate limiting
            if not _auth_limiter.is_allowed(client_ip):
                logger.warning(f"LOGIN_RATE_LIMITED ip={client_ip}")
                error_html = '<div class="alert">Too many attempts. Try again in a minute.</div>'
                csrf_token = _generate_csrf_token()
                return Response(
                    LOGIN_HTML.replace("{{ERROR}}", error_html).replace("{{CSRF_TOKEN}}", csrf_token),
                    content_type="text/html",
                )
            # CSRF validation
            if not _validate_csrf_token():
                logger.warning(f"LOGIN_CSRF_FAIL ip={client_ip}")
                error_html = '<div class="alert">Session expired. Please try again.</div>'
                csrf_token = _generate_csrf_token()
                return Response(
                    LOGIN_HTML.replace("{{ERROR}}", error_html).replace("{{CSRF_TOKEN}}", csrf_token),
                    content_type="text/html",
                )

            pw = request.form.get("password", "")
            configured_pw = remote_auth.get("password", "")

            if pw and pw == configured_pw:
                session["authed"] = True
                session["auth_exp"] = time.time() + session_timeout * 60
                logger.info(f"LOGIN_OK ip={client_ip}")
                return redirect(request.args.get("next") or "/")

            logger.warning(f"LOGIN_FAIL ip={client_ip}")
            error_html = '<div class="alert">Invalid password</div>'

        csrf_token = _generate_csrf_token()
        return Response(
            LOGIN_HTML.replace("{{ERROR}}", error_html).replace("{{CSRF_TOKEN}}", csrf_token),
            content_type="text/html",
        )

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect("/login")

    # ---- PIN verification ----

    @app.route("/api/auth/verify-pin", methods=["POST"])
    def verify_pin():
        client_ip = request.remote_addr or "unknown"
        if not _auth_limiter.is_allowed(f"pin:{client_ip}"):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        data = request.get_json(silent=True) or {}
        pin = data.get("pin", "")
        if pin == settings_pin:
            return jsonify({"success": True}), 200
        return jsonify({"success": False, "error": "Invalid PIN"}), 401

    @app.route("/api/auth/verify-secure-pin", methods=["POST"])
    def verify_secure_pin():
        client_ip = request.remote_addr or "unknown"
        if not _auth_limiter.is_allowed(f"secure_pin:{client_ip}"):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        data = request.get_json(silent=True) or {}
        pin = data.get("pin", "")
        if not secure_pin:
            return jsonify({"success": False, "error": "Secure PIN not configured"}), 503
        if pin == secure_pin:
            return jsonify({"success": True}), 200
        return jsonify({"success": False, "error": "Invalid PIN"}), 401
