# Repository Review: STP_tablets

## What this application does

This repository hosts the **tablet-facing AV control system** for St. Paul Church:

- A **vanilla JS single-page frontend** for iPads/kiosk tablets (`frontend/`) that provides room pages (main, chapel, social, gym, conference, streaming, source routing, security, settings).
- A **Python Flask + Socket.IO gateway** (`gateway/gateway.py`) that:
  - serves the frontend,
  - exposes a unified REST API,
  - proxies to middleware for X32/MoIP/OBS,
  - controls PTZ cameras and Epson projectors server-side,
  - executes automation macros,
  - publishes real-time state updates to all tablets.

## Critical improvements (priority order)

### P0 — Remove hardcoded secrets and credentials from repo

Move secrets into environment variables or encrypted secret storage and rotate all exposed values:

- Home Assistant long-lived token in `gateway/config.yaml`
- API keys in `gateway/config.yaml`
- `security.secret_key`, `remote_auth.password`, and `settings_pin`
- `frontend/config/permissions.json` PIN duplication

Also commit a `config.example.yaml` and add `.gitignore` rules for real config + SQLite WAL artifacts.

### P0 — Tighten authentication/authorization model

Current model relies heavily on source IP and a shared settings PIN, with frontend session state in `sessionStorage`.

Recommended:

- Introduce per-user auth for privileged operations (at minimum for settings/security/macro execution).
- Sign and validate server-side sessions only (no trust in client-side auth flags).
- Add route-level authorization checks for all state-changing API endpoints and Socket.IO events.
- Add brute-force protection/rate limits on `/api/auth/verify-pin` and `/login`.

### P1 — Split `gateway.py` into modules and add automated tests

`gateway/gateway.py` is a large monolith (routing, auth, macro engine, DB, polling, scheduler, socket handlers).

Refactor into modules:

- `auth.py`
- `api_routes.py`
- `macro_engine.py`
- `polling.py`
- `socket_handlers.py`
- `db.py`

Then add tests:

- auth + permission tests,
- macro execution validation tests,
- API contract tests (happy path + failure path),
- mock-mode integration test.

### P1 — Make deployment safer and reproducible

- Add pinned Python version + lockfile.
- Add health/readiness endpoints with clear dependency status.
- Add service unit examples (systemd/launchd) and restart/backoff guidance.
- Prevent tracking runtime database artifacts (`*.db-wal`, `*.db-shm`) in git.

### P2 — Improve frontend resilience and security defaults

- Remove fail-open behavior when permissions are missing (`Auth.hasPermission` currently returns `true` when config isn't loaded).
- Add explicit error UX when `/api/config` is unavailable.
- Add request retry/backoff policies per API class.
- Consider TypeScript or JSDoc + linting for maintainability.

## Suggested first implementation batch (highest ROI)

1. Secret externalization + credential rotation.
2. Fail-closed authorization in frontend and gateway route guards.
3. Add test scaffold (`pytest`) with auth and critical API tests.
4. Break out `gateway.py` into modules without behavior changes.

