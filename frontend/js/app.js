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

    // Apply saved theme and density before anything renders
    this.initTheme();
    this.initDensity();

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

    // Setup status bar
    this.updateStatusBar();
    this.startClock();
    this.startHealthPolling();
    this.startDeviceInfoPolling();

    // Setup PIN overlay
    this.setupPINOverlay();

    // Initialize Socket.IO connection
    this.initSocketIO();

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

    this.socket = io({
      query: { tablet: tabletId },
      reconnection: true,
      reconnectionDelay: 1000 + Math.floor(Math.random() * 2000),  // jitter to avoid thundering herd
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      timeout: 60000,           // 60s — match server ping_timeout for WiFi tolerance
    });

    this.socket.on('connect', () => {
      console.log('Socket.IO connected');
      this._reconnectAttempt = 0;
      this.setConnectionStatus('Connected', true);

      // Report previous disconnect reason to server for diagnostics
      if (this._lastDisconnectReason) {
        this.socket.emit('diag', { prev_disconnect: this._lastDisconnectReason });
        this._lastDisconnectReason = null;
      }

      // Join rooms for all subsystems
      this.socket.emit('join', { room: 'moip' });
      this.socket.emit('join', { room: 'x32' });
      this.socket.emit('join', { room: 'obs' });
      this.socket.emit('join', { room: 'projectors' });
      this.socket.emit('join', { room: 'camlytics' });
      this.socket.emit('join', { room: 'ha' });
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
    });

    this.socket.io.on('reconnect', () => {
      this._reconnectAttempt = 0;
      clearTimeout(this._disconnectUiTimer);
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

    // Heartbeat — report presence every 30 seconds
    this._heartbeatInterval = setInterval(() => {
      if (this.socket && this.socket.connected) {
        this.socket.emit('heartbeat', {
          tablet: Auth.getTabletId(),
          displayName: Auth.getDisplayName(),
          role: Auth.currentRole,
          currentPage: Router.currentPage,
        });
      }
    }, 30000);
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
      }
      return originalFetch.call(this, input, init);
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

  refreshCurrentPage(subsystem) {
    // If the current page cares about this subsystem's data, trigger a UI refresh
    const page = Router.currentPage;
    const handler = Router.pages[page];

    // Map subsystems to pages that display their data
    const subsystemPages = {
      x32: ['settings', 'main'],
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
      let label = Auth.getDisplayName();
      if (Auth.isRoleOverridden()) {
        label += ` (${Auth.getRoleDisplayName()})`;
      }
      tabletEl.textContent = label;
    }

    this.setConnectionStatus('Connecting...', false);
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
    const update = async () => {
      const state = await HealthAPI.poll();
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

      // Stale data indicator
      if (healthSection) {
        if (state.stale) {
          healthSection.style.opacity = '0.4';
          healthSection.title = 'Health data is stale — dashboard may be unreachable';
        } else {
          healthSection.style.opacity = '';
          healthSection.title = '';
        }
      }
    };
    update();
    this.healthTimer = setInterval(update, 30000);

    // Make health pills clickable — navigate to built-in health page
    const healthSection = document.getElementById('status-health');
    if (healthSection) {
      healthSection.style.cursor = 'pointer';
      healthSection.addEventListener('click', () => Router.navigate('health'));
    }
  },

  _deviceInfoFailCount: 0,

  startDeviceInfoPolling() {
    const update = async () => {
      try {
        const resp = await fetch('http://127.0.0.1:2323/?password=admin&cmd=deviceInfo&type=json',
          { signal: AbortSignal.timeout(3000) });
        const info = await resp.json();
        this._deviceInfoFailCount = 0;
        this._updateBattery(info.batteryLevel, info.isPlugged);
        this._updateWifi(info.wifiSignalLevel);
      } catch {
        this._deviceInfoFailCount++;
        // Only hide after 3 consecutive failures (not a one-off glitch)
        if (this._deviceInfoFailCount >= 3) {
          const bat = document.getElementById('status-battery');
          const wifi = document.getElementById('status-wifi');
          if (bat) bat.style.display = 'none';
          if (wifi) wifi.style.display = 'none';
        }
        // Keep polling — Fully Kiosk may come back online
      }
    };
    update();
    this._deviceInfoTimer = setInterval(update, 30000);
  },

  _updateBattery(level, isPlugged) {
    const pctEl = document.getElementById('battery-pct');
    const batEl = document.getElementById('status-battery');
    if (!batEl) return;
    const icon = batEl.querySelector('.material-icons');
    if (level == null) { batEl.style.display = 'none'; return; }
    batEl.style.display = '';
    if (pctEl) pctEl.textContent = `${Math.round(level)}%`;
    if (icon) {
      if (isPlugged) icon.textContent = 'battery_charging_full';
      else if (level > 80) icon.textContent = 'battery_full';
      else if (level > 50) icon.textContent = 'battery_5_bar';
      else if (level > 20) icon.textContent = 'battery_3_bar';
      else icon.textContent = 'battery_1_bar';
    }
    if (level <= 15) batEl.style.color = 'var(--down)';
    else batEl.style.color = '';
  },

  _updateWifi(signalLevel) {
    const wifiEl = document.getElementById('status-wifi');
    if (!wifiEl) return;
    const icon = wifiEl.querySelector('.material-icons');
    if (signalLevel == null) { wifiEl.style.display = 'none'; return; }
    wifiEl.style.display = '';
    if (icon) {
      if (signalLevel >= 3) icon.textContent = 'wifi';
      else if (signalLevel >= 2) icon.textContent = 'wifi_2_bar';
      else if (signalLevel >= 1) icon.textContent = 'wifi_1_bar';
      else icon.textContent = 'wifi_off';
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
  // Toast notifications
  // -----------------------------------------------------------------------

  showToast(message, duration = 2000, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, duration);
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
  // Density toggle (comfortable / compact)
  // -----------------------------------------------------------------------

  initDensity() {
    const saved = localStorage.getItem('density') || 'comfortable';
    if (saved === 'compact') document.body.classList.add('compact');
    this._updateDensityIcon(saved);

    document.getElementById('density-toggle')?.addEventListener('click', () => {
      const isCompact = document.body.classList.toggle('compact');
      const mode = isCompact ? 'compact' : 'comfortable';
      localStorage.setItem('density', mode);
      this._updateDensityIcon(mode);
    });
  },

  _updateDensityIcon(mode) {
    const icon = document.querySelector('#density-toggle .material-icons');
    if (icon) icon.textContent = mode === 'compact' ? 'density_small' : 'density_medium';
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
          "Hi! I'm the AV Help Assistant. Ask me anything about operating the church AV system \u2014 how to use buttons, troubleshooting, or what a feature does.");
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
