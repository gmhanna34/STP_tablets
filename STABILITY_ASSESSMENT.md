# Stability & Maintainability Assessment

*Consolidated review — March 2026*
*Combines independent assessments from Codex (REPOSITORY_REVIEW.md) and Claude Code with full codebase analysis.*

---

## Executive Summary

The STP gateway+frontend system is **functionally solid** — it successfully consolidates 5+ standalone services into a single process, handles multiple real-time protocols, and provides a responsive tablet UI. The consolidation work (Phases 1-7) was well-executed with consistent patterns across modules.

However, the system has accumulated technical debt typical of rapid feature absorption: a 4,000-line monolith, silent exception handling in critical paths, thread-safety gaps in the gateway core, and a frontend auth model that fails open. None of these are causing outages today, but they increase the blast radius of future changes and make debugging harder than it needs to be.

Initial analysis flagged frontend Socket.IO event listener leaks, but code review confirmed handlers are registered once and properly cleaned up. The real frontend gaps were fail-open permissions and missing user feedback on auth/permission failures.

The recommendations below are prioritized by **operational impact** — what's most likely to cause a hard-to-diagnose outage or data loss.

---

## P0 — Must Fix (Operational Risk)

### 1. Add Logging to Silent Exception Handlers

**Problem:** 15+ locations across `gateway.py` and the modules catch exceptions with bare `pass` — no log, no metric, no trace. When something goes wrong in production, there's no breadcrumb trail.

**Worst offenders:**
- `gateway.py:264` — Audit log write failures silently ignored (could mask DB corruption)
- `gateway.py:1438` — MoIP state refresh failures silently dropped
- `gateway.py:3701-3760` — All poller error handlers return `None` with no logging
- `x32_module.py:177-196` — 15 consecutive silent exception blocks during snapshot parsing (56 potential silent failures per cycle across channels/buses/DCAs)
- `obs_module.py:180` — WebSocket close failures hidden

**Fix:** Change every `except Exception: pass` to at minimum `except Exception as e: logger.debug(...)`. For critical paths (polling, state sync, audit), use `logger.warning()`.

**Effort:** Low (mechanical find-and-replace with appropriate log levels)

### 2. Externalize Secrets from Config Files

*Aligned with Codex P0 recommendation.*

**Problem:** `gateway/config.yaml` contains the Home Assistant long-lived access token, API keys, `secret_key`, and `settings_pin` in plaintext, checked into git.

**Fix:**
- Move all secrets to `.env` (already partially done for MoIP credentials in Phase 2)
- Create `config.example.yaml` with placeholder values
- Add `.env`, `*.db-wal`, `*.db-shm` to `.gitignore`
- Rotate all exposed credentials after migration

**Effort:** Low-medium (Phase 5 in the consolidation plan already covers this)

### 3. Fix Fail-Open Permission Check in Frontend

*Aligned with Codex P0 recommendation.*

**Problem:** `auth.js:114` — `hasPermission()` returns `true` when no role config is loaded:
```javascript
hasPermission(page) {
    const role = this.getRoleConfig();
    if (!role) return true; // Fail open if no config
    return role.permissions[page] !== false;
}
```

If the gateway is down or `/api/config` fails, every page is accessible to every tablet — including settings, security, and macro execution.

**Fix:** Invert the default: `if (!role) return false;`. Add a visible error banner when config fails to load so operators know something is wrong rather than silently granting full access.

**Effort:** Low (one-line change + error UX)

### 4. Harden Frontend Event Listener Lifecycle

**Problem (revised):** Initial analysis flagged Socket.IO event listeners as leaking on every reconnection. On closer inspection, `initSocketIO()` and `MacroAPI._bindSocketEvents()` are each called exactly once — Socket.IO client preserves handlers across reconnections, so they do NOT accumulate. All five pages that register `MacroAPI.onStateChange()` properly remove their listeners in `destroy()`.

However, there were still real issues addressed:
- `MacroAPI._bindSocketEvents()` had no guard against accidental double-registration
- `MacroAPI._notifyListeners()` silently swallowed errors in listener callbacks
- The router's `navigate()` gave no user feedback when permission was denied
- No visible error when permissions failed to load (fail-closed change made pages silently inaccessible)

**Fix (applied in Batch 1):**
- Added `_socketBound` guard in `MacroAPI._bindSocketEvents()` to prevent double-registration
- Changed silent `catch` in `_notifyListeners()` to log errors to console
- Added user-visible toast messages when navigation is denied (distinguishes "no permission" from "permissions unavailable")
- Added red error banner when permissions fail to load, with Reload button

**Effort:** Low

### 5. Implement Graceful Shutdown

**Problem:** `gateway.py` has no signal handlers. When the process is stopped (SIGTERM from systemd/launchd, Ctrl+C), all daemon threads are killed instantly. This can corrupt:
- In-flight macro executions (partial device state)
- SQLite writes (WAL not flushed)
- Active WebSocket/Telnet/OSC connections (no clean disconnect)

Additionally, `gateway.py:1369` falls back to `os._exit(0)` which bypasses all cleanup.

**Fix:**
- Add `signal.signal(SIGTERM, shutdown_handler)` that sets a shutdown flag
- Each module already has a `stop()` or cleanup pattern — call them in order
- Replace `os._exit(0)` with `sys.exit(0)` + atexit hooks
- Flush SQLite WAL on shutdown

**Effort:** Medium

---

## P1 — Should Fix (Maintainability & Reliability)

### 6. Add Thread Synchronization to Gateway Shared State

**Problem:** Several mutable globals in `gateway.py` are read/written from multiple threads without locks:
- `_verbose_logging` (line 659) — toggled from HTTP handler, read from all threads
- `_ha_device_cache` (line 2118) — dict rebuilt by poller, read by HTTP handlers
- `_sid_to_tablet` / `_sid_connect_time` (line 3558) — modified in SocketIO callbacks from concurrent connections

The modules themselves are well-synchronized (all use `threading.Lock`), but the gateway core does not follow the same discipline.

**Fix:** Add `threading.Lock` around each shared mutable. For simple flags like `_verbose_logging`, consider `threading.Event` instead.

**Effort:** Low-medium

### 7. Split `gateway.py` into Modules

*Aligned with Codex P1 recommendation.*

**Problem:** `gateway.py` is 4,006 lines containing routing, auth, macro engine, database, polling, scheduling, and SocketIO handlers. This makes:
- Code review difficult (changes touch unrelated sections)
- Testing impossible (no way to import individual components)
- Merge conflicts likely when multiple people work on it

**Recommended split:**
| New File | Responsibility | Approx Lines |
|----------|---------------|--------------|
| `gateway_app.py` | Flask/SocketIO setup, startup | ~200 |
| `auth.py` | IP allowlist, PIN, sessions, permissions | ~300 |
| `api_routes.py` | REST endpoint handlers | ~1,200 |
| `macro_engine.py` | Macro parsing, execution, step types | ~800 |
| `polling.py` | Background pollers, state cache, watchdog | ~400 |
| `scheduler.py` | Cron-like schedule execution | ~200 |
| `database.py` | SQLite audit log, schedule DB | ~300 |
| `socket_handlers.py` | SocketIO events, rooms, heartbeat | ~300 |

**Approach:** Pure structural refactor — extract functions without changing behavior. Each module gets its own file and imports shared state from a central context object.

**Effort:** High (but zero-risk if done as pure move + import changes)

### 8. Optimize Home Assistant Entity Polling

**Problem:** `gateway.py:3745-3762` fetches each HA entity individually:
```python
for entity_id in ha_state_entities:
    resp = http_requests.get(f"{ha_cfg['url']}/api/states/{entity_id}", ...)
```
If monitoring 100 entities, this makes 100 HTTP calls every 15 seconds. The bulk `/api/states` endpoint exists and is already used elsewhere in the code (line 2107).

**Fix:** Use the bulk endpoint and filter client-side. Single HTTP call instead of N.

**Effort:** Low

### 9. Fix State Broadcasting Noise

**Problem:** `gateway.py:3675` broadcasts state to all connected tablets whenever polled data changes:
```python
if data is not None and state_cache.set(name, data):
    socketio.emit(f"state:{name}", data, room=name)
```

The X32 snapshot includes `age_seconds` which changes every poll cycle (5s), causing a broadcast to all tablets every 5 seconds even when no mixer state actually changed. This wastes bandwidth on WiFi-connected tablets.

**Fix:** Strip volatile fields (like `age_seconds`, `last_poll_ts`) before comparing cached state. Only broadcast when actionable state changes.

**Effort:** Low

### 10. Add Automated Test Scaffold

*Aligned with Codex P1 recommendation.*

**Problem:** Zero automated tests. Changes are validated only by manual testing on physical tablets/devices.

**Recommended starting test suite:**
| Test Area | What to Test | Framework |
|-----------|-------------|-----------|
| Auth | PIN verification, session expiry, IP allowlist | pytest + Flask test client |
| Permissions | Role resolution, page access, fail-closed | pytest |
| Macros | Step execution order, error handling, depth limit | pytest + mocking |
| API contracts | Status codes, response shapes for all endpoints | pytest + Flask test client |
| State cache | Thread-safe set/get, change detection | pytest |

**Effort:** Medium (scaffold + 20-30 initial tests)

### 11. Add Poller Auto-Recovery

**Problem:** If a poller thread dies (unhandled exception escaping the try/except), it stays dead. The watchdog tracks heartbeat staleness but doesn't restart failed pollers. The operator sees stale data but no alert.

**Fix:**
- Wrap each poller's main loop in a top-level try/except that logs and restarts
- Add a `poller_died` alert type to the health module
- Consider using `concurrent.futures.ThreadPoolExecutor` with `Future` monitoring instead of raw daemon threads

**Effort:** Medium

### 12. Make Deployment Reproducible

*Aligned with Codex P1 recommendation.*

**Fix:**
- Pin Python version in `.python-version` or `pyproject.toml`
- Generate `requirements.lock` (or use `pip freeze > requirements.lock`)
- Add example systemd/launchd unit files to the repo
- Add a `/readiness` endpoint that checks all module connections before returning 200

**Effort:** Low-medium

---

## P2 — Nice to Have (Hardening & Polish)

### 13. Add Request Retry/Timeout Consistency

**Problem:** Timeouts are hardcoded inconsistently across the codebase:
- PTZ cameras: `timeout=3` (hardcoded)
- Projectors: `timeout=5` (hardcoded)
- Camlytics: `timeout=2` (hardcoded)
- HA calls: `timeout` from config (good)
- Frontend API calls: No timeout on most `fetch()` calls (only PIN verification uses `AbortSignal.timeout`)

**Fix:**
- Move all timeouts to `config.yaml` under a `timeouts:` section
- Add `AbortSignal.timeout()` to all frontend API calls
- Add retry with backoff for transient failures (HTTP 502/503/504)

**Effort:** Low-medium

### 14. Improve Frontend Offline Resilience

**Problem:** When the gateway is unreachable:
- Config fallback loads static JSON files (good)
- But the fallback `settings.json` still references `external.stpauloc.org:20855` (the old health dashboard URL)
- No visual indication that the app is in degraded mode
- Socket.IO reconnects forever (`reconnectionAttempts: Infinity`) which is correct, but no "gateway down" page

**Fix:**
- Add a degraded-mode banner: "Operating in offline mode — some features unavailable"
- Update `settings.json` to remove stale health dashboard URL
- After N failed reconnects (e.g., 30), show a "Reload" button instead of spinning forever

**Effort:** Low

### 15. Add CSRF Protection for Login Form

**Problem:** The login form (`gateway.py:789-931`) uses a plain HTML form POST without CSRF tokens. On the local network this is low-risk, but it's a defense-in-depth gap.

**Fix:** Add Flask-WTF or a simple session-based CSRF token to the login form.

**Effort:** Low

### 16. Harden Session Management

**Problem:**
- `auth.js:181` — Session token is just `Date.now().toString()` stored in `sessionStorage`. It's not cryptographically signed or validated server-side.
- `gateway.py:946` — Server session uses absolute timeout only (no idle timeout, no activity refresh)

**Fix:**
- Issue a signed session token from the gateway (Flask's built-in session signing)
- Add idle timeout (reset expiry on activity)
- Validate token server-side on protected routes

**Effort:** Medium

### 17. Add Rate Limiting on Auth Endpoints

*Aligned with Codex P0 recommendation (downgraded to P2 for LAN-only deployment).*

**Problem:** `/api/auth/verify-pin` and `/login` have no rate limiting. An attacker on the LAN could brute-force the 4-digit PIN.

**Fix:** Add Flask-Limiter or a simple in-memory counter (e.g., 5 attempts per minute per IP).

**Effort:** Low

### 18. Memory Safeguards for Long-Running Process

**Problem areas:**
- `occupancy_module.py:126-141` — `all_daily_peaks` list grows unbounded with years of CSV data
- `health_module.py:92-94` — `_results` and `_alert_state` dicts never evict removed services
- `gateway.py:3558` — `_sid_to_tablet` could accumulate stale entries if `disconnect` events are missed

**Fix:**
- Cap occupancy data to last 365 days
- Clean orphaned health service results on config reload
- Add periodic cleanup of stale SocketIO session entries (e.g., older than 24h)

**Effort:** Low

### 19. Snapshot Consistency Under Concurrency

**Problem:** `x32_module.py` and `health_module.py` return state snapshots without holding the lock during serialization. A poller thread could update the dict between when the Flask handler reads field A and field B, resulting in a half-old/half-new response.

**Fix:** Deep-copy the snapshot inside the lock before returning:
```python
with self._lock:
    return copy.deepcopy(self._snapshot)
```

**Effort:** Low

---

## Module-Specific Findings

### Gateway Modules (x32, moip, obs) — Generally Well-Built

**Strengths:**
- All use `threading.Lock` for shared state (consistent pattern)
- Connection management with exponential backoff (moip, obs)
- Graceful degradation — return cached data when offline
- Failure streak logging (1st + every 5th attempt)

**Improvement areas:**
- `x32_module.py:41-50` — Manual `__enter__`/`__exit__` instead of `with` statement; fragile cleanup
- `moip_module.py:220` — Error logs don't include the command that failed
- `obs_module.py:201-214` — After a recv timeout, socket is left in unknown state (should disconnect + reconnect on next attempt)

### Health Module — Comprehensive But Could Be Tighter

**Strengths:**
- 9 check types covering HTTP, TCP, process, composite, and custom checks
- Latency tracking on all checks
- Two-stage PING/SNAPSHOT pattern avoids hammering slow services

**Improvement areas:**
- `ffprobe_path` detection (`shutil.which`) is cached once at startup — if ffprobe is installed later, requires gateway restart
- Process checks use PID without creation-time validation (low risk of PID reuse false positives)
- Alert state accumulates indefinitely for removed services

### Occupancy Module — Solid But Platform-Sensitive

**Strengths:**
- Clean pandas-based CSV parsing
- Daily download scheduler with proper locking
- Graceful fallback when data directory missing

**Improvement areas:**
- `occupancy_module.py:36` — Hardcoded Windows path `r"C:\Users\info\Box\Reports"` will fail on Mac migration (Phase 8). Should move to config or environment variable.
- CSV column matching is fragile — if Camlytics changes column names, data silently becomes zero instead of raising an alert

### Frontend — Good UX Patterns, Critical Memory Leak Issues

**Strengths:**
- Socket.IO reconnection with jitter (avoids thundering herd)
- 3-second grace period hides brief WiFi blips from users
- Centralized timer registry (`_timers[]`) for leak prevention
- `_patchFetch()` auto-injects tablet ID on all API calls
- Socket.IO CDN has a local fallback script

**Corrected findings (updated after code review):**
- Initial analysis incorrectly flagged Socket.IO event listeners as leaking on every reconnection. Both `initSocketIO()` and `_bindSocketEvents()` are called exactly once — Socket.IO client preserves handlers across reconnections. All five pages that register `MacroAPI.onStateChange()` properly call `removeStateListener()` in their `destroy()` methods.
- Added `_socketBound` guard in `MacroAPI._bindSocketEvents()` for defense-in-depth against future double-registration.
- **Unhandled async errors** — Event listeners call async API methods (e.g., `ObsAPI.startStream()`) without `await` or `.catch()`. Failures are silently swallowed; user sees no feedback.
- **Missing fetch timeouts** — Most `fetch()` calls lack `AbortSignal.timeout()` (only PIN verification uses it). If gateway is slow, UI hangs.
- **No centralized error handling** — Each page handles API errors independently (or doesn't)
- **`settings.json`** references stale external health dashboard URL (`external.stpauloc.org:20855`)
- **Chart.js CDN** has no local fallback (Socket.IO CDN does)

---

## Recommended Implementation Order

| Batch | Items | Effort | Impact |
|-------|-------|--------|--------|
| **Batch 1** | #1 (logging), #2 (secrets), #3 (fail-closed auth), #4 (Socket.IO leaks) | 1-2 sessions | Eliminates blind spots, security gaps, and tablet memory leaks |
| **Batch 2** | #5 (shutdown), #6 (thread safety), #8 (HA polling), #9 (broadcast noise) | 1-2 sessions | Operational stability |
| **Batch 3** | #7 (split gateway.py), #10 (tests) | 2-3 sessions | Maintainability foundation |
| **Batch 4** | #11-19 (hardening) | 2-3 sessions | Defense in depth |

---

## Comparison with Codex Review

| Codex Recommendation | This Assessment | Alignment |
|---------------------|-----------------|-----------|
| P0: Externalize secrets | P0 #2 | Fully aligned |
| P0: Tighten auth model | P0 #3 (fail-closed) + P2 #16-17 (sessions, rate limit) | Aligned; auth tightening deprioritized slightly for LAN-only context |
| P1: Split gateway.py + tests | P1 #7 + #10 | Fully aligned |
| P1: Reproducible deployment | P1 #12 | Fully aligned |
| P2: Frontend resilience | P0 #3-4 + P2 #13-14 | Elevated fail-open and Socket.IO leaks to P0; rest aligned |

**Additional findings not in Codex review:**
- Silent exception handling (P0 #1) — highest operational impact finding
- Frontend Socket.IO event listener memory leaks (P0 #4) — critical for 24/7 kiosk tablets
- Graceful shutdown (P0 #5) — data corruption risk
- Thread safety in gateway core (P1 #6)
- HA polling inefficiency (P1 #8)
- State broadcasting noise (P1 #9)
- Poller auto-recovery (P1 #11)
- Memory safeguards (P2 #18)
- Snapshot consistency (P2 #19)
- Hardcoded Windows path in occupancy module (needs fixing before Phase 8 Mac migration)
- Frontend: unhandled async errors in event listeners, missing fetch timeouts, Chart.js CDN without fallback
