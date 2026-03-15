// Main Application Controller
const App = {
  settings: null,
  devicesConfig: null,
  healthTimer: null,
  clockTimer: null,
  socket: null,
  _timers: [],     // centralized timer registry for leak prevention

  async init() {
    console.log('St. Paul Control Panel - Initializing...');

    // Patch global fetch to auto-inject X-Tablet-ID header on all API requests.
    // This eliminates [Unknown] in gateway logs for pages that call fetch() directly.
    this._patchFetch();

    // Apply saved theme before anything renders
    this.initTheme();

    // Load configuration from gateway
    let config = null;
    try {
      const configResp = await fetch('/api/config');
      console.log('[CONFIG] /api/config status:', configResp.status);
      if (!configResp.ok) throw new Error(`Config response ${configResp.status}`);
      config = await configResp.json();
      console.log('[CONFIG] Response keys:', Object.keys(config));
      console.log('[CONFIG] devices keys:', config.devices ? Object.keys(config.devices) : 'MISSING');
      console.log('[CONFIG] has moip:', !!(config.devices && config.devices.moip));
      if (!config.devices) throw new Error('Config missing devices');
      this.settings = config.settings || {};
      this.devicesConfig = config.devices || {};
    } catch (e) {
      console.warn('[CONFIG] Gateway config failed, falling back to static files:', e.message);
      try {
        const [settingsResp, devicesResp] = await Promise.all([
          fetch('config/settings.json'),
          fetch('config/devices.json')
        ]);
        console.log('[CONFIG] Static fallback status:', settingsResp.status, devicesResp.status);
        this.settings = await settingsResp.json();
        this.devicesConfig = await devicesResp.json();
        console.log('[CONFIG] Static fallback devices keys:', Object.keys(this.devicesConfig));
      } catch (e2) {
        console.error('[CONFIG] Static fallback also failed:', e2);
        this.settings = {};
        this.devicesConfig = {};
      }
    }
    console.log('[CONFIG] Final devicesConfig has moip:', !!this.devicesConfig?.moip,
                'receivers:', this.devicesConfig?.moip?.receivers?.length || 0);

    // Initialize auth/permissions (pass config to avoid duplicate /api/config fetch)
    await Auth.init(config);

    // Show error banner if permissions failed to load (fail-closed — all pages denied)
    if (Auth.permissionsLoadFailed) {
      this.showPermissionsError();
    }

    // Initialize API services (no config params needed — they use gateway-relative URLs)
    ObsAPI.init(this.settings);
    X32API.init();
    MoIPAPI.init();
    // WattBoxAPI removed — WattBox controls are now macros with ha_service actions
    PtzAPI.init();
    EpsonAPI.init();
    HealthAPI.init(this.settings);

    // Initialize router
    Router.init();
    Router.updateNavVisibility();

    // Setup mobile nav drawer (phones only)
    this.initMobileNav();

    // Setup status bar
    this.updateStatusBar();
    this.startClock();
    this.startHealthPolling();

    // Setup PIN overlays
    this.setupPINOverlay();
    this.setupSecurePINOverlay();

    // Initialize Socket.IO connection
    this.initSocketIO();

    // Initialize notification center (before macro API so it's available for events)
    if (typeof NotificationCenter !== 'undefined') NotificationCenter.init();

    // Initialize macro API (after socket is ready)
    MacroAPI.init();

    // Navigate to initial page
    const hash = window.location.hash.replace('#', '');
    const startPage = hash && Auth.hasPermission(hash) ? hash : 'home';
    Router.navigate(startPage, false);

    console.log('St. Paul Control Panel - Ready');
  },

  // -----------------------------------------------------------------------
  // Socket.IO — real-time state sync
  // -----------------------------------------------------------------------

  initSocketIO() {
    if (typeof io === 'undefined') {
      console.warn('Socket.IO client not loaded — falling back to polling only');
      return;
    }

    const tabletId = Auth.getTabletId();
    this._reconnectAttempt = 0;

    this._sessionCount = 0;  // track how many times this page has connected

    const socketQuery = { tablet: tabletId };
    if (Auth.isUserSession()) {
      socketQuery.user = Auth.userSession.username;
      socketQuery.user_display = Auth.userSession.display_name;
    }

    this.socket = io({
      query: socketQuery,
      reconnection: true,
      reconnectionDelay: 1000 + Math.floor(Math.random() * 2000),  // jitter to avoid thundering herd
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      timeout: 60000,           // 60s — match server ping_timeout for WiFi tolerance
    });

    this.socket.on('connect', () => {
      this._sessionCount++;
      console.log(`Socket.IO connected (session #${this._sessionCount})`);
      this._reconnectAttempt = 0;
      clearTimeout(this._disconnectBannerTimer);
      this._hideDisconnectBanner();
      document.getElementById('gateway-reload-overlay')?.remove();
      this.setConnectionStatus('Connected', true);

      // Report previous disconnect reason + WiFi quality to server for diagnostics
      if (this._lastDisconnectReason) {
        const diagData = {
          prev_disconnect: this._lastDisconnectReason,
          session_count: this._sessionCount,
          downtime_ms: this._disconnectedAt ? Date.now() - this._disconnectedAt : null,
        };
        // Measure round-trip latency to gateway
        const rttStart = Date.now();
        fetch('/api/health', { signal: AbortSignal.timeout(5000) })
          .then(() => {
            diagData.rtt_ms = Date.now() - rttStart;
            this.socket.emit('diag', diagData);
          })
          .catch(() => {
            diagData.rtt_ms = null;
            this.socket.emit('diag', diagData);
          });
        this._lastDisconnectReason = null;
      }

      // Join rooms for all subsystems
      this.socket.emit('join', { room: 'moip' });
      this.socket.emit('join', { room: 'x32' });
      this.socket.emit('join', { room: 'obs' });
      this.socket.emit('join', { room: 'projectors' });
      this.socket.emit('join', { room: 'camlytics' });
      this.socket.emit('join', { room: 'ha' });
      this.socket.emit('join', { room: 'health' });
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('Socket.IO disconnected:', reason);
      this._lastDisconnectReason = reason;
      this._disconnectedAt = Date.now();
      // Delay showing "Disconnected" UI by 3s — hides brief WiFi blips
      clearTimeout(this._disconnectUiTimer);
      this._disconnectUiTimer = setTimeout(() => {
        if (!this.socket.connected) {
          this.setConnectionStatus('Disconnected', false);
        }
      }, 3000);
      // Show prominent disconnect banner after 10s of sustained disconnection
      clearTimeout(this._disconnectBannerTimer);
      this._disconnectBannerTimer = setTimeout(() => {
        if (!this.socket.connected) {
          this._showDisconnectBanner();
        }
      }, 10000);
    });

    this.socket.on('connect_error', () => {
      // Only show error after the grace period
      if (this._disconnectedAt && Date.now() - this._disconnectedAt > 3000) {
        this.setConnectionStatus('Connection Error', false);
      }
    });

    this.socket.io.on('reconnect_attempt', (attempt) => {
      this._reconnectAttempt = attempt;
      // Only show reconnecting UI after the grace period
      if (this._disconnectedAt && Date.now() - this._disconnectedAt > 3000) {
        this.setConnectionStatus(`Reconnecting (${attempt})...`, false);
      }
      // After 30 failed attempts (~5 min), show reload overlay
      if (attempt >= 30 && !document.getElementById('gateway-reload-overlay')) {
        this._showReloadOverlay();
      }
    });

    this.socket.io.on('reconnect', () => {
      this._reconnectAttempt = 0;
      clearTimeout(this._disconnectUiTimer);
      clearTimeout(this._disconnectBannerTimer);
      this._hideDisconnectBanner();
      this._hideRestartOverlay();
      const downtime = this._disconnectedAt ? Date.now() - this._disconnectedAt : 0;
      this._disconnectedAt = null;
      // Only show toast + re-navigate for long disconnects (>3s)
      // Brief WiFi blips are invisible to the user
      if (downtime > 3000) {
        this.showToast('Reconnected to gateway', 2000);
        Router.navigate(Router.currentPage, false);
      }
    });

    this.socket.io.on('reconnect_failed', () => {
      this.setConnectionStatus('Reconnect Failed', false);
      this.showToast('Lost connection to gateway — reload to retry', 5000);
    });

    // State push handlers — update local state and refresh visible pages
    this.socket.on('state:x32', (data) => {
      X32API.onStateUpdate(data);
      this.refreshCurrentPage('x32');
    });

    this.socket.on('state:moip', (data) => {
      MoIPAPI.onStateUpdate(data);
      this.refreshCurrentPage('moip');
    });

    this.socket.on('state:obs', (data) => {
      ObsAPI.onStateUpdate(data);
      this.refreshCurrentPage('obs');
    });

    this.socket.on('state:projectors', (data) => {
      this.refreshCurrentPage('projectors');
    });

    this.socket.on('state:camlytics', (data) => {
      this.refreshCurrentPage('camlytics');
    });

    this.socket.on('state:health', (data) => {
      if (data && data.counts) {
        HealthAPI.state.downCount = data.counts.down || 0;
        HealthAPI.state.warningCount = data.counts.warning || 0;
        HealthAPI.state.healthyCount = data.counts.healthy || 0;
        HealthAPI.state.totalCount = data.total || 0;
        HealthAPI.state.stale = false;
        this._updateHealthPills(HealthAPI.state);
      }
    });

    // Scene progress — show real-time feedback during server-side scene execution
    this.socket.on('scene:progress', (data) => {
      if (!data) return;
      const { label, status, steps_completed, steps_total, error } = data;
      if (status === 'completed') {
        this.showToast(`${label}: Complete (${steps_completed}/${steps_total} switches)`, 2000);
      } else if (status === 'failed') {
        this.showToast(`${label}: FAILED — ${error || 'unknown error'}`, 4000);
      } else if (status === 'in_progress') {
        this.showToast(`${label}: ${steps_completed}/${steps_total}...`, 1000);
      }
    });

    // Cross-tablet notifications — styled differently from local toasts
    this.socket.on('notification', (data) => {
      if (data && data.message) {
        this.showToast(data.message, 3000, 'notification');
      }
    });

    // Gateway restart notification — show full-screen overlay until reconnected
    this.socket.on('gateway:restarting', (data) => {
      this._showRestartOverlay(data?.message || 'Gateway is restarting...');
    });

    // Heartbeat — report presence every 30 seconds
    this._heartbeatInterval = setInterval(() => {
      if (this.socket && this.socket.connected) {
        const hb = {
          tablet: Auth.getTabletId(),
          displayName: Auth.getDisplayName(),
          role: Auth.currentRole,
          currentPage: Router.currentPage,
        };
        hb.session_count = this._sessionCount;
        this.socket.emit('heartbeat', hb);
      }
    }, 30000);
  },

  _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  },

  _patchFetch() {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      // Only patch same-origin API requests (not external CDN resources)
      const url = typeof input === 'string' ? input : (input?.url || '');
      if (url.startsWith('/api/') || url.startsWith('api/')) {
        init = init || {};
        init.headers = new Headers(init.headers || {});
        if (!init.headers.has('X-Tablet-ID')) {
          const tabletId = (typeof Auth !== 'undefined' && Auth.getTabletId) ? Auth.getTabletId() : 'Unknown';
          init.headers.set('X-Tablet-ID', tabletId);
        }
        if (!init.headers.has('X-Tablet-Role') && typeof Auth !== 'undefined' && Auth.currentRole) {
          init.headers.set('X-Tablet-Role', Auth.currentRole);
        }
        // Default 10s timeout on all API fetches that don't already have a signal
        if (!init.signal) {
          init.signal = AbortSignal.timeout(10000);
        }
      }
      return originalFetch.call(this, input, init).then(resp => {
        // Auto-redirect to login on 401 (session expired) for API requests
        if (resp.status === 401 && (url.startsWith('/api/') || url.startsWith('api/'))) {
          // Avoid redirect loops — don't redirect if already on login page
          if (window.location.pathname !== '/login') {
            console.warn('[AUTH] Session expired (401) — redirecting to login');
            window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname);
          }
        }
        return resp;
      });
    };
  },

  setConnectionStatus(text, connected) {
    const connEl = document.getElementById('connection-status');
    if (connEl) {
      connEl.textContent = text;
      connEl.classList.toggle('status-connected', connected);
      connEl.classList.toggle('status-disconnected', !connected);
    }
  },

  _showRestartOverlay(message) {
    // Remove existing overlay if any
    this._hideRestartOverlay();
    const overlay = document.createElement('div');
    overlay.id = 'gateway-restart-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-size:18px;gap:16px;';
    overlay.innerHTML = `
      <span class="material-icons" style="font-size:48px;animation:spin 1.5s linear infinite;">sync</span>
      <div>${message}</div>
      <div style="font-size:13px;opacity:0.6;">Reconnecting automatically...</div>
    `;
    // Add spin animation if not present
    if (!document.getElementById('restart-spin-style')) {
      const style = document.createElement('style');
      style.id = 'restart-spin-style';
      style.textContent = '@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
    document.body.appendChild(overlay);
  },

  _hideRestartOverlay() {
    document.getElementById('gateway-restart-overlay')?.remove();
  },

  _showDisconnectBanner() {
    if (document.getElementById('disconnect-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'disconnect-banner';
    banner.className = 'disconnect-banner';
    banner.innerHTML = '<span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:8px;">cloud_off</span>' +
      '<strong>Gateway unreachable</strong> — Controls may not respond. Reconnecting automatically... ' +
      '<button onclick="location.reload()">Reload</button>';
    document.body.prepend(banner);
  },

  _hideDisconnectBanner() {
    document.getElementById('disconnect-banner')?.remove();
  },

  _showReloadOverlay() {
    if (document.getElementById('gateway-reload-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'gateway-reload-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-size:18px;gap:16px;';
    overlay.innerHTML = `
      <span class="material-icons" style="font-size:48px;color:#ff9800;">cloud_off</span>
      <div>Gateway unreachable</div>
      <div style="font-size:14px;opacity:0.7;">Unable to reconnect after multiple attempts</div>
      <button onclick="location.reload()" style="margin-top:12px;padding:12px 32px;font-size:16px;font-weight:600;background:#ff9800;color:#fff;border:none;border-radius:6px;cursor:pointer;">Reload Page</button>
    `;
    document.body.appendChild(overlay);
  },

  refreshCurrentPage(subsystem) {
    // If the current page cares about this subsystem's data, trigger a UI refresh
    const page = Router.currentPage;
    const handler = Router.pages[page];

    // Map subsystems to pages that display their data
    const subsystemPages = {
      x32: ['settings', 'main', 'chapel', 'social', 'gym', 'source'],
      moip: ['source', 'main', 'chapel', 'social', 'gym', 'confroom'],
      obs: ['stream'],
      projectors: ['main'],
    };

    const relevantPages = subsystemPages[subsystem] || [];
    if (relevantPages.includes(page) && handler && handler.updateStatus) {
      handler.updateStatus();
    }
  },

  // -----------------------------------------------------------------------
  // Status bar
  // -----------------------------------------------------------------------

  updateStatusBar() {
    const versionEl = document.getElementById('version-label');
    const tabletEl = document.getElementById('tablet-name');

    if (versionEl) {
      versionEl.textContent = `Version: ${this.settings?.app?.version || '26-012'} - Web App`;
    }
    if (tabletEl) {
      if (Auth.isUserSession()) {
        tabletEl.innerHTML = `<span class="material-icons" style="font-size:16px;vertical-align:text-bottom;margin-right:2px;">person</span>${this._escHtml(Auth.getDisplayName())}`;
      } else {
        let label = Auth.getDisplayName();
        if (Auth.isRoleOverridden()) {
          label += ` (${Auth.getRoleDisplayName()})`;
        }
        tabletEl.textContent = label;
      }
    }

    // Show/hide user menu (change password + sign out)
    const userMenuWrapper = document.getElementById('user-menu-wrapper');
    if (userMenuWrapper) {
      userMenuWrapper.style.display = Auth.isUserSession() ? '' : 'none';
    }
    // Populate username in dropdown
    const userMenuName = document.getElementById('user-menu-name');
    if (userMenuName && Auth.isUserSession()) {
      userMenuName.textContent = Auth.getDisplayName();
    }
    this._initUserMenu();

    this.setConnectionStatus('Connecting...', false);
  },

  _initUserMenu() {
    const btn = document.getElementById('user-menu-btn');
    const dropdown = document.getElementById('user-menu-dropdown');
    const changePwBtn = document.getElementById('user-change-pw-btn');
    if (!btn || !dropdown) return;
    if (btn._wired) return;  // avoid double-wiring
    btn._wired = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { dropdown.style.display = 'none'; });
    if (changePwBtn) {
      changePwBtn.addEventListener('click', () => {
        dropdown.style.display = 'none';
        this._showChangePasswordForm();
      });
    }
  },

  _showChangePasswordForm() {
    const overlay = document.createElement('div');
    overlay.id = 'change-pw-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary,#1e1e2e);border-radius:12px;padding:24px;max-width:380px;width:100%;">
        <h3 style="margin:0 0 16px 0;">Change Password</h3>
        <label style="display:block;margin-bottom:4px;font-size:13px;">Current Password</label>
        <input id="cp-current" type="password" autocomplete="current-password"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:12px;font-size:15px;">
        <label style="display:block;margin-bottom:4px;font-size:13px;">New Password</label>
        <input id="cp-new" type="password" autocomplete="new-password"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:12px;font-size:15px;">
        <label style="display:block;margin-bottom:4px;font-size:13px;">Confirm New Password</label>
        <input id="cp-confirm" type="password" autocomplete="new-password"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:16px;font-size:15px;">
        <div id="cp-error" style="color:var(--danger);font-size:13px;margin-bottom:8px;display:none;"></div>
        <div style="display:flex;gap:8px;">
          <button class="btn" id="cp-cancel" style="flex:1;"><span class="btn-label">Cancel</span></button>
          <button class="btn active" id="cp-save" style="flex:1;"><span class="btn-label">Change</span></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('cp-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('cp-save').addEventListener('click', async () => {
      const errEl = document.getElementById('cp-error');
      errEl.style.display = 'none';
      const current = document.getElementById('cp-current').value;
      const newPw = document.getElementById('cp-new').value;
      const confirm = document.getElementById('cp-confirm').value;
      if (!current) { errEl.textContent = 'Enter your current password'; errEl.style.display = 'block'; return; }
      if (newPw.length < 4) { errEl.textContent = 'New password must be at least 4 characters'; errEl.style.display = 'block'; return; }
      if (newPw !== confirm) { errEl.textContent = 'Passwords do not match'; errEl.style.display = 'block'; return; }
      try {
        const resp = await fetch('/api/users/me/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current_password: current, new_password: newPw }),
        });
        const data = await resp.json();
        if (!resp.ok) { errEl.textContent = data.error || 'Failed'; errEl.style.display = 'block'; return; }
        overlay.remove();
        this.showToast('Password changed successfully', 3000);
      } catch (e) { errEl.textContent = 'Network error'; errEl.style.display = 'block'; }
    });
  },

  startClock() {
    const update = () => {
      const clockEl = document.getElementById('clock');
      if (clockEl) {
        const now = new Date();
        let hours = now.getHours();
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        clockEl.textContent = `${hours.toString().padStart(2, '0')}:${minutes} ${ampm}`;
      }
    };
    update();
    this.clockTimer = setInterval(update, 1000);
  },

  startHealthPolling() {
    // Initial fetch — subsequent updates come via Socket.IO (state:health)
    HealthAPI.poll().then(state => this._updateHealthPills(state));

    // Make health pills clickable — navigate to built-in health page
    const healthSection = document.getElementById('status-health');
    if (healthSection) {
      healthSection.style.cursor = 'pointer';
      healthSection.addEventListener('click', () => Router.navigate('health'));
    }
  },

  _updateHealthPills(state) {
    const downEl = document.getElementById('health-down-count');
    const warnEl = document.getElementById('health-warning-count');
    const healthyEl = document.getElementById('health-healthy-count');
    const healthSection = document.getElementById('status-health');

    if (downEl) {
      downEl.textContent = state.downCount;
      downEl.style.display = state.downCount > 0 ? 'inline-flex' : 'none';
    }
    if (warnEl) {
      warnEl.textContent = state.warningCount;
      warnEl.style.display = state.warningCount > 0 ? 'inline-flex' : 'none';
    }
    if (healthyEl) {
      healthyEl.textContent = state.healthyCount;
      healthyEl.style.display = state.healthyCount > 0 ? 'inline-flex' : 'none';
    }

    if (healthSection) {
      if (state.stale) {
        healthSection.style.opacity = '0.4';
        healthSection.title = 'Health data is stale — dashboard may be unreachable';
      } else {
        healthSection.style.opacity = '';
        healthSection.title = '';
      }
    }
  },

  openHealthDashPanel() {
    this.showPanel('System Health', async (body) => {
      body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.5;">Loading…</div>';
      try {
        const [sumResp, svcResp, statusResp] = await Promise.all([
          fetch('/api/healthdash/summary', { signal: AbortSignal.timeout(5000) }),
          fetch('/api/healthdash/services', { signal: AbortSignal.timeout(5000) }),
          fetch('/api/healthdash/status', { signal: AbortSignal.timeout(5000) }),
        ]);
        if (!sumResp.ok || !svcResp.ok || !statusResp.ok) throw new Error('Failed to load health data');
        const summary = await sumResp.json();
        const svcData = await svcResp.json();
        const statusData = await statusResp.json();

        const counts = summary.counts || {};
        const services = svcData.services || [];
        const results = statusData.results || {};

        // Build ordered list: match visible services to their results, sort by severity
        const order = { down: 0, warning: 1, healthy: 2 };
        const rows = services.map(svc => {
          const r = results[svc.id] || {};
          const lvl = r?.status?.level || 'unknown';
          return { id: svc.id, name: svc.name, level: lvl, message: r.message || r?.status?.label || '' };
        }).sort((a, b) => (order[a.level] ?? 0) - (order[b.level] ?? 0));

        const esc = s => (s ?? '').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        let html = `
          <div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
            ${counts.down ? `<span class="health-badge health-down" style="display:inline-flex;width:auto;padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600;">${counts.down} Down</span>` : ''}
            ${counts.warning ? `<span class="health-badge health-warning" style="display:inline-flex;width:auto;padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600;">${counts.warning} Warning</span>` : ''}
            ${counts.healthy ? `<span class="health-badge health-healthy" style="display:inline-flex;width:auto;padding:4px 12px;border-radius:12px;font-size:13px;font-weight:600;">${counts.healthy} Healthy</span>` : ''}
          </div>
          <div style="max-height:60vh;overflow-y:auto;">
        `;

        rows.forEach(r => {
          const dotColor = r.level === 'healthy' ? 'var(--ok)' : r.level === 'warning' ? 'var(--warn)' : 'var(--down)';
          html += `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border-color, rgba(255,255,255,0.08));">
              <span style="width:10px;height:10px;border-radius:50%;background:${dotColor};flex-shrink:0;"></span>
              <span style="flex:1;font-size:13px;">${esc(r.name)}</span>
              <span style="font-size:11px;opacity:0.6;max-width:40%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.message)}</span>
            </div>
          `;
        });

        html += '</div>';
        html += `<div style="margin-top:16px;text-align:center;">
          <button id="health-panel-fullpage" class="btn" style="font-size:13px;">
            <span class="material-icons" style="font-size:16px;vertical-align:middle;margin-right:4px;">open_in_full</span>
            Open Full Dashboard
          </button>
        </div>`;

        body.innerHTML = html;
        document.getElementById('health-panel-fullpage')?.addEventListener('click', () => {
          this.closePanel();
          Router.navigate('health');
        });
      } catch (e) {
        body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--down);">
          <span class="material-icons" style="font-size:48px;display:block;margin-bottom:8px;">error_outline</span>
          Health data unavailable<br><small style="opacity:0.6;">${e.message}</small>
        </div>`;
      }
    });
  },

  // -----------------------------------------------------------------------
  // PIN Entry Overlay (now async for server-side verification)
  // -----------------------------------------------------------------------
  pinBuffer: '',
  pinDestination: '',

  setupPINOverlay() {
    const overlay = document.getElementById('pin-overlay');
    if (!overlay) return;

    overlay.querySelectorAll('.pin-key').forEach(key => {
      key.addEventListener('click', async () => {
        const val = key.dataset.key;
        if (val === 'clear') {
          this.pinBuffer = '';
        } else if (val === 'enter') {
          // Auth.login is now async (server-side PIN verification)
          const success = await Auth.login(this.pinBuffer);
          if (success) {
            const dest = this.pinDestination;
            this.hidePINEntry();
            if (dest) {
              Router.navigate(dest);
            }
          } else {
            this.pinBuffer = '';
            this.showToast('Incorrect PIN');
            const modal = document.getElementById('pin-modal');
            if (modal) {
              modal.style.animation = 'none';
              modal.offsetHeight;
              modal.style.animation = 'shake 0.5s ease-in-out';
            }
          }
        } else {
          if (this.pinBuffer.length < 6) {
            this.pinBuffer += val;
          }
        }
        this.updatePINDots();
      });
    });

    const closeBtn = document.getElementById('pin-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.hidePINEntry());
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hidePINEntry();
    });
  },

  showPINEntry(destination) {
    this.pinBuffer = '';
    this.pinDestination = destination || '';
    this.updatePINDots();
    const overlay = document.getElementById('pin-overlay');
    if (overlay) { overlay.classList.remove('hidden'); overlay.classList.add('visible'); }
  },

  hidePINEntry() {
    const overlay = document.getElementById('pin-overlay');
    if (overlay) { overlay.classList.remove('visible'); overlay.classList.add('hidden'); }
    this.pinBuffer = '';
    this.pinDestination = '';
  },

  updatePINDots() {
    const dots = document.querySelectorAll('.pin-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < this.pinBuffer.length);
    });
  },

  // -----------------------------------------------------------------------
  // Secure PIN Entry Overlay (always prompts — no session caching)
  // -----------------------------------------------------------------------
  securePinBuffer: '',
  securePinCallback: null,

  setupSecurePINOverlay() {
    const overlay = document.getElementById('secure-pin-overlay');
    if (!overlay) return;

    overlay.querySelectorAll('.pin-key').forEach(key => {
      key.addEventListener('click', async () => {
        const val = key.dataset.key;
        if (val === 'clear') {
          this.securePinBuffer = '';
        } else if (val === 'enter') {
          const success = await Auth.verifySecurePIN(this.securePinBuffer);
          if (success) {
            const cb = this.securePinCallback;
            this.hideSecurePINEntry();
            if (cb) cb(true);
          } else {
            this.securePinBuffer = '';
            this.showToast('Incorrect PIN');
            const modal = document.getElementById('secure-pin-modal');
            if (modal) {
              modal.style.animation = 'none';
              modal.offsetHeight;
              modal.style.animation = 'shake 0.5s ease-in-out';
            }
          }
        } else {
          if (this.securePinBuffer.length < 6) {
            this.securePinBuffer += val;
          }
        }
        this.updateSecurePINDots();
      });
    });

    const closeBtn = document.getElementById('secure-pin-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        const cb = this.securePinCallback;
        this.hideSecurePINEntry();
        if (cb) cb(false);
      });
    }

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        const cb = this.securePinCallback;
        this.hideSecurePINEntry();
        if (cb) cb(false);
      }
    });
  },

  showSecurePINEntry(callback) {
    this.securePinBuffer = '';
    this.securePinCallback = callback || null;
    this.updateSecurePINDots();
    const overlay = document.getElementById('secure-pin-overlay');
    if (overlay) { overlay.classList.remove('hidden'); overlay.classList.add('visible'); }
  },

  hideSecurePINEntry() {
    const overlay = document.getElementById('secure-pin-overlay');
    if (overlay) { overlay.classList.remove('visible'); overlay.classList.add('hidden'); }
    this.securePinBuffer = '';
    this.securePinCallback = null;
  },

  updateSecurePINDots() {
    const dots = document.querySelectorAll('#secure-pin-display .pin-dot');
    dots.forEach((dot, i) => {
      dot.classList.toggle('filled', i < this.securePinBuffer.length);
    });
  },

  // -----------------------------------------------------------------------
  // Toast notifications
  // -----------------------------------------------------------------------

  showToast(message, duration = 2000, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    // Warning and error toasts are tappable — opens notification center
    if ((type === 'warning' || type === 'error') && typeof NotificationCenter !== 'undefined') {
      toast.style.cursor = 'pointer';
      toast.addEventListener('click', () => {
        toast.remove();
        NotificationCenter.open();
      });
    }
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  showPermissionsError() {
    const banner = document.createElement('div');
    banner.className = 'permissions-error-banner';
    banner.innerHTML = '<strong>Permissions unavailable</strong> — Cannot reach gateway. All pages are locked. <button onclick="location.reload()">Reload</button>';
    document.body.prepend(banner);
  },

  // -----------------------------------------------------------------------
  // Timer registry — prevents interval/timeout leaks on page navigation
  // -----------------------------------------------------------------------

  /**
   * Register a setInterval that will be auto-cleared on page switch.
   * @param {Function} fn - Callback
   * @param {number} ms - Interval in milliseconds
   * @returns {number} The interval ID
   */
  registerTimer(fn, ms) {
    const id = setInterval(fn, ms);
    this._timers.push(id);
    return id;
  },

  /**
   * Clear all page-scoped timers. Called automatically on page navigation.
   */
  clearPageTimers() {
    for (const id of this._timers) {
      clearInterval(id);
    }
    this._timers = [];
  },

  // -----------------------------------------------------------------------
  // Theme toggle (light / dark)
  // -----------------------------------------------------------------------

  initTheme() {
    const saved = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    this._updateThemeIcon(saved);

    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') || 'light';
      const next = current === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('theme', next);
      this._updateThemeIcon(next);
    });
  },

  _updateThemeIcon(theme) {
    const icon = document.querySelector('#theme-toggle .material-icons');
    if (icon) icon.textContent = theme === 'light' ? 'dark_mode' : 'light_mode';
  },

  // -----------------------------------------------------------------------
  // Mobile nav drawer (phones only)
  // -----------------------------------------------------------------------

  initMobileNav() {
    const toggle = document.getElementById('mobile-menu-toggle');
    const drawer = document.getElementById('mobile-nav-drawer');
    const overlay = document.getElementById('mobile-nav-overlay');
    if (!toggle || !drawer) return;

    const openDrawer = () => {
      drawer.classList.add('open');
      overlay?.classList.add('open');
    };

    const closeDrawer = () => {
      drawer.classList.remove('open');
      overlay?.classList.remove('open');
    };

    toggle.addEventListener('click', () => {
      drawer.classList.contains('open') ? closeDrawer() : openDrawer();
    });

    // Close when tapping overlay
    overlay?.addEventListener('click', closeDrawer);

    // Wire up drawer nav items
    drawer.querySelectorAll('.drawer-item').forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        if (page) Router.navigate(page);
        closeDrawer();
      });
    });

    // Expose close method for Router to call on navigation
    this.closeMobileNav = closeDrawer;
  },

  // -----------------------------------------------------------------------
  // Panel overlay (page-within-a-page)
  // -----------------------------------------------------------------------

  /**
   * Show a panel overlay (~80% of screen, slides up from bottom).
   * @param {string} title - Panel header title
   * @param {function(HTMLElement)} renderContent - Called with the panel body element; populate it.
   * @returns {HTMLElement} The overlay element (call App.closePanel() or overlay.remove() to close)
   */
  showPanel(title, renderContent) {
    // Remove any existing panel
    this.closePanel();

    const overlay = document.createElement('div');
    overlay.className = 'panel-overlay';
    overlay.id = 'panel-overlay';
    overlay.innerHTML = `
      <div class="panel-container">
        <div class="panel-header">
          <h2>${title}</h2>
          <button class="panel-close"><span class="material-icons">close</span></button>
        </div>
        <div class="panel-body"></div>
      </div>
    `;

    // Close on backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.closePanel();
    });

    // Close on X button
    overlay.querySelector('.panel-close').addEventListener('click', () => this.closePanel());

    document.body.appendChild(overlay);

    // Let the caller populate the body
    const body = overlay.querySelector('.panel-body');
    if (renderContent) renderContent(body);

    return overlay;
  },

  closePanel() {
    const existing = document.getElementById('panel-overlay');
    if (existing) existing.remove();
  },

  // -----------------------------------------------------------------------
  // AV Help Chatbot
  // -----------------------------------------------------------------------

  _chatHistory: null,

  _loadChatHistory() {
    if (this._chatHistory) return;
    try {
      const stored = sessionStorage.getItem('chatHistory');
      this._chatHistory = stored ? JSON.parse(stored) : [];
    } catch { this._chatHistory = []; }
  },

  _saveChatHistory() {
    try {
      sessionStorage.setItem('chatHistory', JSON.stringify(this._chatHistory || []));
    } catch { /* quota exceeded — ignore */ }
  },

  openChat(page) {
    this._loadChatHistory();
    const currentPage = page || (typeof Router !== 'undefined' ? Router.currentPage : '') || '';

    this.showPanel('AV Help Assistant', (body) => {
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.padding = '0';
      body.style.height = '100%';

      body.innerHTML = `
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-bar">
          <input type="text" id="chat-input" placeholder="Ask a question..." autocomplete="off">
          <button id="chat-send">
            <span class="material-icons" style="font-size:20px;">send</span>
          </button>
        </div>
      `;

      const messagesEl = document.getElementById('chat-messages');
      const inputEl = document.getElementById('chat-input');
      const sendBtn = document.getElementById('chat-send');

      // Render existing history or welcome message
      if (this._chatHistory.length === 0) {
        this._chatAddBubble(messagesEl, 'bot',
          "Hi! I'm the AV Help Assistant. I can answer questions about the AV system and take actions for you \u2014 like turning on audio/video, switching sources, or creating schedules. Just ask!");
      } else {
        for (const msg of this._chatHistory) {
          this._chatAddBubble(messagesEl, msg.role === 'user' ? 'user' : 'bot', msg.content);
        }
      }

      const doSend = async () => {
        const text = inputEl.value.trim();
        if (!text) return;
        inputEl.value = '';

        // Add user bubble
        this._chatAddBubble(messagesEl, 'user', text);
        this._chatHistory.push({ role: 'user', content: text });
        this._saveChatHistory();

        // Show typing indicator
        const typing = document.createElement('div');
        typing.className = 'chat-typing';
        typing.textContent = 'Thinking\u2026';
        messagesEl.appendChild(typing);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        try {
          const resp = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: text,
              page: currentPage,
              history: this._chatHistory.slice(0, -1), // exclude current message (already in body)
            }),
          });
          const data = await resp.json();
          typing.remove();

          if (data.response) {
            // Show action summary chips if actions were taken
            if (data.actions && data.actions.length > 0) {
              this._chatAddActionSummary(messagesEl, data.actions);
            }
            this._chatAddBubble(messagesEl, 'bot', data.response);
            this._chatHistory.push({ role: 'assistant', content: data.response });
            this._saveChatHistory();
          } else {
            this._chatAddBubble(messagesEl, 'bot',
              data.error || 'Sorry, something went wrong. Please try again.');
          }
        } catch {
          typing.remove();
          this._chatAddBubble(messagesEl, 'bot',
            'Unable to reach the help assistant. Please check your connection and try again.');
        }
      };

      sendBtn.addEventListener('click', doSend);
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doSend();
      });

      // Auto-focus input
      setTimeout(() => inputEl.focus(), 300);
    });
  },

  _chatAddBubble(container, type, text) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble ${type}`;
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
  },

  _chatAddActionSummary(container, actions) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-actions';
    for (const action of actions) {
      const chip = document.createElement('div');
      chip.className = 'chat-action-chip';
      const result = action.result || {};
      const success = result.success !== false;
      const icon = success ? 'check_circle' : 'error';
      const iconColor = success ? '#4caf50' : '#f44336';
      let label = '';
      if (action.tool === 'execute_macro') {
        label = result.label || action.input.macro_key || 'Macro';
      } else if (action.tool === 'create_schedule') {
        label = 'Schedule: ' + (result.name || action.input.name || 'Created');
      } else if (action.tool === 'update_schedule') {
        label = 'Schedule updated';
      } else if (action.tool === 'delete_schedule') {
        label = 'Schedule deleted';
      } else if (action.tool === 'list_schedules') {
        label = (result.count || 0) + ' schedule(s)';
      } else if (action.tool === 'get_system_state') {
        label = 'State checked';
      } else if (action.tool === 'move_camera_preset') {
        label = (result.name || action.input.camera_key || 'Camera') + ' \u2192 preset ' + (action.input.preset_number || '?');
      } else if (action.tool === 'get_health_status') {
        const c = result.counts || {};
        label = (c.down || 0) > 0 ? (c.down + ' service(s) down') : 'All healthy';
      } else if (action.tool === 'preview_macro') {
        label = 'Preview: ' + (result.label || action.input.macro_key || 'macro');
      } else {
        label = action.tool;
      }
      chip.innerHTML = `<span class="material-icons" style="font-size:16px;color:${iconColor};vertical-align:middle;margin-right:4px;">${icon}</span>${label}`;
      wrapper.appendChild(chip);
    }
    container.appendChild(wrapper);
    container.scrollTop = container.scrollHeight;
  },

  // -----------------------------------------------------------------------
  // Confirmation dialog for destructive operations
  // -----------------------------------------------------------------------

  showConfirm(message) {
    return new Promise((resolve) => {
      // Remove any existing confirm overlay
      document.getElementById('confirm-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'confirm-overlay';
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-modal">
          <div class="confirm-message">${message}</div>
          <div class="confirm-buttons">
            <button class="btn confirm-cancel">Cancel</button>
            <button class="btn confirm-ok btn-danger">Confirm</button>
          </div>
        </div>
      `;

      overlay.querySelector('.confirm-cancel').addEventListener('click', () => {
        overlay.remove();
        resolve(false);
      });
      overlay.querySelector('.confirm-ok').addEventListener('click', () => {
        overlay.remove();
        resolve(true);
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      });

      document.body.appendChild(overlay);
    });
  },

  // -----------------------------------------------------------------------
  // Multi-option choice dialog
  // -----------------------------------------------------------------------

  /**
   * Show a dialog with multiple option buttons plus a Cancel.
   * @param {string} message - Prompt text (HTML allowed)
   * @param {Array<{label:string, value:any, icon?:string, danger?:boolean}>} options
   * @returns {Promise<any|null>} The chosen option's value, or null if cancelled
   */
  showChoices(message, options) {
    return new Promise((resolve) => {
      document.getElementById('choices-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'choices-overlay';
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-modal choices-modal">
          <div class="confirm-message">${message}</div>
          <div class="choices-list">
            ${options.map((opt, i) => `
              <button class="btn choices-option ${opt.danger ? 'btn-danger' : ''}" data-choice-idx="${i}">
                ${opt.icon ? `<span class="material-icons" style="font-size:18px;">${opt.icon}</span>` : ''}
                <span>${opt.label}</span>
              </button>
            `).join('')}
          </div>
          <div class="choices-cancel-row">
            <button class="btn choices-cancel">Cancel</button>
          </div>
        </div>
      `;

      const close = (val) => { overlay.remove(); resolve(val); };

      overlay.querySelector('.choices-cancel').addEventListener('click', () => close(null));
      overlay.querySelectorAll('.choices-option').forEach(btn => {
        btn.addEventListener('click', () => close(options[parseInt(btn.dataset.choiceIdx)].value));
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });

      document.body.appendChild(overlay);
    });
  }
};

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
