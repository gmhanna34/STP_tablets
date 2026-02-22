// Main Application Controller
const App = {
  settings: null,
  devicesConfig: null,
  healthTimer: null,
  clockTimer: null,
  socket: null,

  async init() {
    console.log('St. Paul Control Panel - Initializing...');

    // Apply saved theme before anything renders
    this.initTheme();

    // Load configuration from gateway
    try {
      const configResp = await fetch('/api/config');
      const config = await configResp.json();
      this.settings = config.settings || {};
      this.devicesConfig = config.devices || {};
    } catch (e) {
      console.warn('Gateway config unavailable, falling back to static files');
      try {
        const [settingsResp, devicesResp] = await Promise.all([
          fetch('config/settings.json'),
          fetch('config/devices.json')
        ]);
        this.settings = await settingsResp.json();
        this.devicesConfig = await devicesResp.json();
      } catch (e2) {
        console.error('Failed to load config:', e2);
        this.settings = {};
        this.devicesConfig = {};
      }
    }

    // Initialize auth/permissions
    await Auth.init();

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

    const tabletId = localStorage.getItem('tabletId') || 'WebApp';
    this._reconnectAttempt = 0;

    this.socket = io({
      query: { tablet: tabletId },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
    });

    this.socket.on('connect', () => {
      console.log('Socket.IO connected');
      this._reconnectAttempt = 0;
      this.setConnectionStatus('Connected', true);

      // Join rooms for all subsystems
      this.socket.emit('join', { room: 'moip' });
      this.socket.emit('join', { room: 'x32' });
      this.socket.emit('join', { room: 'obs' });
      this.socket.emit('join', { room: 'projectors' });
    });

    this.socket.on('disconnect', (reason) => {
      console.warn('Socket.IO disconnected:', reason);
      this.setConnectionStatus('Disconnected', false);
    });

    this.socket.on('connect_error', () => {
      this.setConnectionStatus('Connection Error', false);
    });

    this.socket.io.on('reconnect_attempt', (attempt) => {
      this._reconnectAttempt = attempt;
      this.setConnectionStatus(`Reconnecting (${attempt})...`, false);
    });

    this.socket.io.on('reconnect', () => {
      this._reconnectAttempt = 0;
      this.showToast('Reconnected to gateway', 2000);
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
          tablet: tabletId,
          displayName: Auth.getDisplayName(),
          currentPage: Router.currentPage,
        });
      }
    }, 30000);
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
      versionEl.textContent = `Version: ${this.settings?.app?.version || '26-006'} - Web App`;
    }
    if (tabletEl) {
      tabletEl.textContent = Auth.currentLocation?.replace('Tablet_', '') || 'Unknown';
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

      if (downEl) {
        downEl.textContent = state.downCount;
        downEl.style.display = state.downCount > 0 ? 'inline-block' : 'none';
      }
      if (warnEl) {
        warnEl.textContent = state.warningCount;
        warnEl.style.display = state.warningCount > 0 ? 'inline-block' : 'none';
      }
      if (healthyEl) {
        healthyEl.textContent = state.healthyCount;
        healthyEl.style.display = state.healthyCount > 0 ? 'inline-block' : 'none';
      }
    };
    update();
    this.healthTimer = setInterval(update, 30000);
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
  // Confirmation dialog for destructive operations
  // -----------------------------------------------------------------------

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
  }
};

// Start the application when DOM is ready
document.addEventListener('DOMContentLoaded', () => App.init());
