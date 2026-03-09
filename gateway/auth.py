"""IP allowlist, PIN verification, user auth, sessions, CSRF, rate limiting, and permission enforcement."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from collections import defaultdict

from flask import Response, current_app, jsonify, redirect, request, session, url_for

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


def get_actor() -> str:
    """Return 'user:<username>' for user sessions, 'tablet:<id>' for tablet requests.

    This provides a unified actor identity for audit logging regardless of
    whether the request came from a logged-in user or a LAN tablet.
    """
    user = session.get("user")
    if user:
        return f"user:{user}"
    return f"tablet:{get_tablet_id()}"


def get_tablet_role(permissions_data: dict) -> str:
    """Get the tablet's current role from header, falling back to defaultRole."""
    role = request.headers.get("X-Tablet-Role", "")
    if role and role in (permissions_data.get("roles") or {}):
        return role
    return permissions_data.get("defaultRole", "full_access")


def check_permission(tablet_id: str, required_page: str, permissions_data: dict):
    """Returns an error response tuple if permission denied, None if OK.

    Priority:
    1. User session role (server-side, not spoofable via header)
    2. X-Tablet-Role header (for LAN tablets)
    3. Old-style location key backwards compat
    4. Unknown: fail-open for tablets, fail-closed for user sessions
    """
    roles = permissions_data.get("roles", {})

    # User session: role stored server-side (not from header)
    user_role = session.get("user_role") if session else None
    if user_role and user_role in roles:
        perms = roles[user_role].get("permissions", {})
        if perms.get(required_page) is False:
            return jsonify({"error": "Permission denied", "page": required_page}), 403
        return None

    # Tablet path: check X-Tablet-Role header
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

    # User sessions without a recognized role: fail-closed
    if session and session.get("user"):
        logger.warning(f"Permission check: user={session.get('user')} has unrecognized role "
                       f"{user_role!r}, page={required_page} — denying")
        return jsonify({"error": "Permission denied", "page": required_page}), 403

    # Unknown tablet / no role header — allow (fail-open) for now
    logger.debug(f"Permission check: no recognised role for tablet={tablet_id}, "
                 f"role_header={role_key!r}, page={required_page} — allowing (fail-open)")
    return None




# ---------------------------------------------------------------------------
# CSRF token helpers
# ---------------------------------------------------------------------------

_CSRF_MAX_AGE = 3600  # token valid for 1 hour


def _generate_csrf_token() -> str:
    """Create an HMAC-signed, timestamped CSRF token (no session required)."""
    ts = str(int(time.time()))
    key = current_app.config["SECRET_KEY"].encode() or b"fallback-csrf-key"
    sig = hmac.new(key, ts.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{ts}.{sig}"


def _validate_csrf_token() -> bool:
    """Verify the HMAC signature and age of the submitted CSRF token."""
    submitted = request.form.get("csrf_token", "")
    if not submitted or "." not in submitted:
        return False
    ts, sig = submitted.split(".", 1)
    try:
        age = time.time() - int(ts)
    except ValueError:
        return False
    if age < 0 or age > _CSRF_MAX_AGE:
        return False
    key = current_app.config["SECRET_KEY"].encode() or b"fallback-csrf-key"
    expected_sig = hmac.new(key, ts.encode(), hashlib.sha256).hexdigest()[:32]
    return hmac.compare_digest(sig, expected_sig)


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
    trusted_proxy_prefixes = ctx.trusted_proxy_prefixes
    settings_pin = ctx.settings_pin
    secure_pin = ctx.secure_pin
    remote_auth = ctx.remote_auth
    session_timeout = ctx.session_timeout
    user_module = getattr(ctx, "user_module", None)

    def _get_client_ip() -> str:
        """Return the real client IP, respecting X-Forwarded-For from trusted proxies."""
        remote_addr = request.remote_addr or ""
        forwarded_for = request.headers.get("X-Forwarded-For", "")
        if forwarded_for and (
            not trusted_proxy_prefixes
            or any(remote_addr.startswith(pfx) for pfx in trusted_proxy_prefixes)
        ):
            return forwarded_for.split(",")[0].strip()
        return remote_addr

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
        return _ip_allowed(_get_client_ip()) or _session_is_authed()

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

        client_ip = _get_client_ip()

        # If remote_auth or user accounts are configured, redirect to login
        has_login = remote_auth.get("password") or (user_module is not None)
        if has_login:
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
        client_ip = _get_client_ip()
        actor = get_actor()
        logger.info(
            f"[{actor}] ip={client_ip} {request.method} {request.path} -> {resp.status_code}"
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
            client_ip = _get_client_ip()
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

            username = request.form.get("username", "").strip()
            pw = request.form.get("password", "")

            # Try user-based auth first (users.yaml)
            if user_module and username:
                user_info = user_module.authenticate(username, pw)
                if user_info:
                    session.permanent = True
                    session["authed"] = True
                    session["user"] = user_info["username"]
                    session["user_role"] = user_info["role"]
                    session["user_display"] = user_info["display_name"]
                    session["auth_exp"] = time.time() + session_timeout * 60
                    logger.info(f"LOGIN_OK user={user_info['username']} ip={client_ip}")
                    return redirect(request.args.get("next") or "/")

            # Fallback: legacy single-password mode
            configured_pw = remote_auth.get("password", "")
            if pw and configured_pw and pw == configured_pw:
                session.permanent = True
                session["authed"] = True
                session["auth_exp"] = time.time() + session_timeout * 60
                logger.info(f"LOGIN_OK ip={client_ip} (legacy password)")
                return redirect(request.args.get("next") or "/")

            logger.warning(f"LOGIN_FAIL ip={client_ip} username={username!r}")
            error_html = '<div class="alert">Invalid username or password</div>'

        csrf_token = _generate_csrf_token()
        return Response(
            LOGIN_HTML.replace("{{ERROR}}", error_html).replace("{{CSRF_TOKEN}}", csrf_token),
            content_type="text/html",
        )

    @app.route("/logout")
    def logout():
        session.clear()
        return redirect("/login")

    # ---- Session info ----

    @app.route("/api/auth/me")
    def auth_me():
        """Return current session identity — user info or tablet info."""
        user = session.get("user")
        if user:
            return jsonify({
                "type": "user",
                "username": user,
                "display_name": session.get("user_display", user),
                "role": session.get("user_role", "full_access"),
            })
        return jsonify({
            "type": "tablet",
            "tablet_id": get_tablet_id(),
        })

    # ---- PIN verification ----

    @app.route("/api/auth/verify-pin", methods=["POST"])
    def verify_pin():
        client_ip = _get_client_ip()
        if not _auth_limiter.is_allowed(f"pin:{client_ip}"):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        data = request.get_json(silent=True) or {}
        pin = data.get("pin", "")
        if pin == settings_pin:
            return jsonify({"success": True}), 200
        return jsonify({"success": False, "error": "Invalid PIN"}), 401

    @app.route("/api/auth/verify-secure-pin", methods=["POST"])
    def verify_secure_pin():
        client_ip = _get_client_ip()
        if not _auth_limiter.is_allowed(f"secure_pin:{client_ip}"):
            return jsonify({"success": False, "error": "Too many attempts"}), 429
        data = request.get_json(silent=True) or {}
        pin = data.get("pin", "")
        if not secure_pin:
            return jsonify({"success": False, "error": "Secure PIN not configured"}), 503
        if pin == secure_pin:
            return jsonify({"success": True}), 200
        return jsonify({"success": False, "error": "Invalid PIN"}), 401
