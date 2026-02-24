const SecurityPage = {
  _feedTimers: {},
  _activeTab: 'ptz',
  _haCameras: null,

  // Access control state
  _locks: [],
  _selected: new Set(),
  _lockPollTimer: null,
  _panelPollTimer: null,

  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>SECURITY</h1>
        <div class="subtitle">Cameras &amp; Access Control</div>
      </div>

      <div class="cam-tab-bar">
        <button class="cam-tab active" data-tab="ptz">
          <span class="material-icons">videocam</span>
          <span>PTZ Cameras</span>
        </button>
        <button class="cam-tab" data-tab="security">
          <span class="material-icons">shield</span>
          <span>Security Cameras</span>
        </button>
        <button class="cam-tab" data-tab="access">
          <span class="material-icons">lock</span>
          <span>Access Control</span>
        </button>
      </div>

      <div id="cam-ptz-content">
        <div class="camera-grid" id="ptz-grid"></div>
        <div class="text-center mt-16">
          <button class="btn" id="btn-security-grid" style="display:inline-flex;max-width:300px;">
            <span class="material-icons">grid_view</span>
            <span class="btn-label">View Security Grid on Displays</span>
          </button>
        </div>
      </div>

      <div id="cam-security-content" style="display:none;">
        <div class="camera-grid" id="security-grid">
          <div style="opacity:0.5;text-align:center;padding:20px;grid-column:1/-1;">Loading security cameras...</div>
        </div>
      </div>

      <div id="cam-access-content" style="display:none;">
        <div class="batch-bar" id="batch-bar" style="display:none;">
          <button class="btn btn-sm" id="btn-select-all">
            <span class="material-icons" style="font-size:18px;">select_all</span>
            <span class="btn-label">Select All</span>
          </button>
          <span class="batch-count" id="batch-count">0 selected</span>
          <div style="flex:1;"></div>
          <button class="btn btn-sm btn-success" id="btn-batch-lock">
            <span class="material-icons" style="font-size:18px;">lock</span>
            <span class="btn-label">Lock Selected</span>
          </button>
          <button class="btn btn-sm btn-danger" id="btn-batch-unlock">
            <span class="material-icons" style="font-size:18px;">lock_open</span>
            <span class="btn-label">Unlock Selected</span>
          </button>
        </div>
        <div class="door-grid" id="door-grid">
          <div style="opacity:0.5;text-align:center;padding:40px;grid-column:1/-1;">Loading doors...</div>
        </div>
      </div>
    `;
  },

  init() {
    this._activeTab = 'ptz';
    this._selected = new Set();

    // Tab switching
    document.querySelectorAll('.cam-tab').forEach(tab => {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    // Render PTZ cameras
    this._renderPTZGrid();
    this._initPTZHandlers();

    // Security grid button
    document.getElementById('btn-security-grid')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('4', '11');
      await MoIPAPI.switchSource('4', '12');
      await MoIPAPI.switchSource('4', '13');
      App.showToast('Security grid sent to lobby displays');
    });

    // Access control batch buttons
    document.getElementById('btn-select-all')?.addEventListener('click', () => this._toggleSelectAll());
    document.getElementById('btn-batch-lock')?.addEventListener('click', () => this._batchAction('lock'));
    document.getElementById('btn-batch-unlock')?.addEventListener('click', () => this._batchAction('unlock'));

    // Start PTZ feeds (default tab)
    const cameraEntries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];
    cameraEntries.forEach(([key]) => this._startPTZFeed(key));
  },

  _switchTab(tab) {
    if (tab === this._activeTab) return;

    // Stop all running feeds and polls
    this._stopAllFeeds();
    this._stopLockPolling();

    this._activeTab = tab;

    // Update tab buttons
    document.querySelectorAll('.cam-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    // Toggle content
    const ptzContent = document.getElementById('cam-ptz-content');
    const secContent = document.getElementById('cam-security-content');
    const accContent = document.getElementById('cam-access-content');
    if (ptzContent) ptzContent.style.display = tab === 'ptz' ? '' : 'none';
    if (secContent) secContent.style.display = tab === 'security' ? '' : 'none';
    if (accContent) accContent.style.display = tab === 'access' ? '' : 'none';

    if (tab === 'ptz') {
      const entries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];
      entries.forEach(([key]) => this._startPTZFeed(key));
    } else if (tab === 'security') {
      this._loadSecurityCameras();
    } else if (tab === 'access') {
      this._loadAccessControl();
    }
  },

  // ===========================================================================
  // PTZ Camera Grid
  // ===========================================================================

  _renderPTZGrid() {
    const grid = document.getElementById('ptz-grid');
    if (!grid) return;
    const entries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];

    grid.innerHTML = entries.map(([key, cam]) => `
      <div class="camera-card" data-cam-click="${key}" data-cam-type="ptz">
        <div class="camera-header">${key.replace(/_/g, ' ')}</div>
        <div class="camera-feed" id="feed-${key}">
          <img id="img-${key}" alt="${key}" style="width:100%;height:100%;object-fit:contain;display:none;">
          <span class="material-icons" id="placeholder-${key}" style="font-size:48px;opacity:0.3;">videocam</span>
          <div id="caption-${key}" style="font-size:12px;opacity:0.4;margin-top:8px;">${cam.ip || cam.name}</div>
        </div>
        <div class="camera-controls">
          <button class="btn" data-cam="${key}" data-ptz-action="preset" data-val="1" style="min-height:36px;padding:4px 8px;"><span class="btn-label">P1</span></button>
          <button class="btn" data-cam="${key}" data-ptz-action="preset" data-val="2" style="min-height:36px;padding:4px 8px;"><span class="btn-label">P2</span></button>
          <button class="btn" data-cam="${key}" data-ptz-action="preset" data-val="3" style="min-height:36px;padding:4px 8px;"><span class="btn-label">P3</span></button>
          <button class="btn" data-cam="${key}" data-ptz-action="home" style="min-height:36px;padding:4px 8px;"><span class="material-icons" style="font-size:16px;">home</span></button>
        </div>
      </div>
    `).join('');
  },

  _initPTZHandlers() {
    document.querySelectorAll('[data-ptz-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const camKey = btn.dataset.cam;
        const action = btn.dataset.ptzAction;
        if (action === 'preset') PtzAPI.callPreset(camKey, btn.dataset.val);
        else if (action === 'home') PtzAPI.home(camKey);
      });
    });

    document.querySelectorAll('[data-cam-click][data-cam-type="ptz"]').forEach(card => {
      card.querySelector('.camera-feed')?.addEventListener('click', () => {
        this._openCameraPanel(card.dataset.camClick, 'ptz');
      });
    });
  },

  _startPTZFeed(camKey) {
    const refresh = () => {
      const img = document.getElementById(`img-${camKey}`);
      if (!img || !img.isConnected) return;
      const next = new Image();
      next.onload = () => {
        img.src = next.src;
        img.style.display = 'block';
        const ph = document.getElementById(`placeholder-${camKey}`);
        const cap = document.getElementById(`caption-${camKey}`);
        if (ph) ph.style.display = 'none';
        if (cap) cap.style.display = 'none';
        this._feedTimers[camKey] = setTimeout(refresh, 2000);
      };
      next.onerror = () => {
        this._feedTimers[camKey] = setTimeout(refresh, 5000);
      };
      next.src = `/api/ptz/${camKey}/snapshot?t=${Date.now()}`;
    };
    refresh();
  },

  // ===========================================================================
  // Security (HA/UniFi Protect) Camera Grid
  // ===========================================================================

  async _loadSecurityCameras() {
    const grid = document.getElementById('security-grid');
    if (!grid) return;

    // Always re-fetch if cache was empty (gateway may have been warming up)
    if (!this._haCameras || this._haCameras.length === 0) {
      this._haCameras = null;
      grid.innerHTML = '<div style="opacity:0.5;text-align:center;padding:20px;grid-column:1/-1;">Loading security cameras...</div>';
      try {
        const resp = await fetch('/api/ha/cameras', {
          headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
        });
        const data = await resp.json();
        if (data.warming || !data.cameras || data.cameras.length === 0) {
          grid.innerHTML = '<div style="opacity:0.5;text-align:center;padding:20px;grid-column:1/-1;">Waiting for camera list from Home Assistant...</div>';
          // Retry in 3 seconds
          this._feedTimers['_ha_retry'] = setTimeout(() => this._loadSecurityCameras(), 3000);
          return;
        }
        this._haCameras = data.cameras;
      } catch (e) {
        grid.innerHTML = '<div style="color:var(--danger);text-align:center;padding:20px;grid-column:1/-1;">Failed to load cameras from Home Assistant.</div>';
        return;
      }
    }

    grid.innerHTML = this._haCameras.map(cam => {
      const safeId = cam.entity_id.replace(/\./g, '_');
      return `
        <div class="camera-card" data-cam-click="${cam.entity_id}" data-cam-type="ha">
          <div class="camera-header">${cam.friendly_name}</div>
          <div class="camera-feed" id="feed-${safeId}">
            <img id="img-${safeId}" alt="${cam.friendly_name}" style="width:100%;height:100%;object-fit:contain;display:none;">
            <span class="material-icons" id="placeholder-${safeId}" style="font-size:48px;opacity:0.3;">videocam</span>
          </div>
        </div>
      `;
    }).join('');

    grid.querySelectorAll('[data-cam-click][data-cam-type="ha"]').forEach(card => {
      card.addEventListener('click', () => {
        this._openCameraPanel(card.dataset.camClick, 'ha');
      });
    });

    this._haCameras.forEach(cam => this._startHAFeed(cam.entity_id));
  },

  _startHAFeed(entityId) {
    const safeId = entityId.replace(/\./g, '_');
    const refresh = () => {
      const img = document.getElementById(`img-${safeId}`);
      if (!img || !img.isConnected) return;
      const next = new Image();
      next.onload = () => {
        img.src = next.src;
        img.style.display = 'block';
        const ph = document.getElementById(`placeholder-${safeId}`);
        if (ph) ph.style.display = 'none';
        this._feedTimers[safeId] = setTimeout(refresh, 3000);
      };
      next.onerror = () => {
        this._feedTimers[safeId] = setTimeout(refresh, 8000);
      };
      next.src = `/api/ha/camera/${entityId}/snapshot?t=${Date.now()}`;
    };
    refresh();
  },

  // ===========================================================================
  // Camera Panel (enlarged single-camera view)
  // ===========================================================================

  _openCameraPanel(camId, type) {
    const self = this;
    let title;

    if (type === 'ptz') {
      title = camId.replace(/_/g, ' ');
    } else {
      const cam = (this._haCameras || []).find(c => c.entity_id === camId);
      title = cam ? cam.friendly_name : camId;
    }

    App.showPanel(title, (body) => {
      body.style.padding = '0';
      body.style.display = 'flex';
      body.style.flexDirection = 'column';

      if (type === 'ptz') {
        body.innerHTML = `
          <div style="flex:1;background:#111;display:flex;align-items:center;justify-content:center;min-height:0;">
            <img id="panel-cam-img" alt="${title}" style="max-width:100%;max-height:100%;object-fit:contain;">
          </div>
          <div style="padding:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;border-top:1px solid var(--border);">
            <button class="btn" data-panel-ptz="preset" data-val="1" style="min-height:40px;padding:8px 16px;"><span class="btn-label">Preset 1</span></button>
            <button class="btn" data-panel-ptz="preset" data-val="2" style="min-height:40px;padding:8px 16px;"><span class="btn-label">Preset 2</span></button>
            <button class="btn" data-panel-ptz="preset" data-val="3" style="min-height:40px;padding:8px 16px;"><span class="btn-label">Preset 3</span></button>
            <button class="btn" data-panel-ptz="home" style="min-height:40px;padding:8px 16px;"><span class="material-icons" style="font-size:18px;">home</span></button>
          </div>
        `;

        body.querySelectorAll('[data-panel-ptz]').forEach(btn => {
          btn.addEventListener('click', () => {
            const action = btn.dataset.panelPtz;
            if (action === 'preset') PtzAPI.callPreset(camId, btn.dataset.val);
            else if (action === 'home') PtzAPI.home(camId);
          });
        });

        const img = body.querySelector('#panel-cam-img');
        const refreshPanel = () => {
          if (!img || !img.isConnected) return;
          const next = new Image();
          next.onload = () => {
            img.src = next.src;
            self._feedTimers['_panel'] = setTimeout(refreshPanel, 1000);
          };
          next.onerror = () => {
            self._feedTimers['_panel'] = setTimeout(refreshPanel, 3000);
          };
          next.src = `/api/ptz/${camId}/snapshot?t=${Date.now()}`;
        };
        refreshPanel();
      } else {
        body.innerHTML = `
          <div style="flex:1;background:#111;display:flex;align-items:center;justify-content:center;min-height:0;">
            <img id="panel-cam-stream" alt="${title}"
              style="max-width:100%;max-height:100%;object-fit:contain;"
              src="/api/ha/camera/${camId}/stream">
          </div>
        `;
      }
    });
  },

  // ===========================================================================
  // Access Control (doors / locks)
  // ===========================================================================

  async _loadAccessControl() {
    const grid = document.getElementById('door-grid');
    if (!grid) return;

    try {
      const resp = await fetch('/api/ha/locks', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const data = await resp.json();
      this._locks = data.locks || [];
    } catch (e) {
      grid.innerHTML = '<div style="color:var(--danger);text-align:center;padding:40px;grid-column:1/-1;">Failed to load doors from Home Assistant.</div>';
      return;
    }

    if (this._locks.length === 0) {
      grid.innerHTML = '<div style="opacity:0.5;text-align:center;padding:40px;grid-column:1/-1;">No lock entities found in Home Assistant.</div>';
      return;
    }

    this._renderDoorGrid();
    this._startLockPolling();
  },

  _renderDoorGrid() {
    const grid = document.getElementById('door-grid');
    if (!grid) return;

    grid.innerHTML = this._locks.map(lock => {
      const safeId = lock.entity_id.replace(/\./g, '_');
      const stateClass = this._doorStateClass(lock.state);
      const checked = this._selected.has(lock.entity_id) ? 'checked' : '';
      const selected = this._selected.has(lock.entity_id) ? ' selected' : '';
      const icon = lock.state === 'unlocked' || lock.state === 'open' ? 'lock_open' : 'lock';

      return `
        <div class="door-card ${stateClass}${selected}" id="card-${safeId}" data-entity="${lock.entity_id}">
          <label class="door-checkbox" onclick="event.stopPropagation();">
            <input type="checkbox" ${checked} data-select="${lock.entity_id}">
          </label>
          <div class="door-card-body" data-door-click="${lock.entity_id}">
            <span class="material-icons door-icon">${icon}</span>
            <div class="door-name">${lock.friendly_name}</div>
            <div class="door-status">${this._doorStateLabel(lock.state)}</div>
            ${lock.door_open !== null ? `<div class="door-position">${lock.door_open === 'on' ? 'Door Open' : ''}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    // Wire checkbox change
    grid.querySelectorAll('input[data-select]').forEach(cb => {
      cb.addEventListener('change', () => {
        const eid = cb.dataset.select;
        if (cb.checked) this._selected.add(eid); else this._selected.delete(eid);
        this._updateSelectionUI();
      });
    });

    // Wire card click → panel
    grid.querySelectorAll('[data-door-click]').forEach(el => {
      el.addEventListener('click', () => this._openDoorPanel(el.dataset.doorClick));
    });

    this._updateSelectionUI();
  },

  _updateLockStates(newLocks) {
    for (const lock of newLocks) {
      const existing = this._locks.find(l => l.entity_id === lock.entity_id);
      if (!existing) { this._locks = newLocks; this._renderDoorGrid(); return; }
      if (existing.state === lock.state && existing.door_open === lock.door_open) continue;

      existing.state = lock.state;
      existing.door_open = lock.door_open;
      existing.changed_by = lock.changed_by;
      existing.lock_rule_entity = lock.lock_rule_entity;
      existing.lock_rule_options = lock.lock_rule_options;
      existing.duration_entity = lock.duration_entity;
      existing.duration_attrs = lock.duration_attrs;

      const safeId = lock.entity_id.replace(/\./g, '_');
      const card = document.getElementById(`card-${safeId}`);
      if (!card) continue;

      card.className = `door-card ${this._doorStateClass(lock.state)}${this._selected.has(lock.entity_id) ? ' selected' : ''}`;
      const iconEl = card.querySelector('.door-icon');
      if (iconEl) iconEl.textContent = (lock.state === 'unlocked' || lock.state === 'open') ? 'lock_open' : 'lock';
      const statusEl = card.querySelector('.door-status');
      if (statusEl) statusEl.textContent = this._doorStateLabel(lock.state);
      const posEl = card.querySelector('.door-position');
      if (posEl) posEl.textContent = lock.door_open === 'on' ? 'Door Open' : '';
    }
  },

  // --- Selection & batch actions ---

  _updateSelectionUI() {
    const bar = document.getElementById('batch-bar');
    const count = document.getElementById('batch-count');
    if (bar) bar.style.display = this._selected.size > 0 ? '' : 'none';
    if (count) count.textContent = `${this._selected.size} selected`;

    this._locks.forEach(lock => {
      const safeId = lock.entity_id.replace(/\./g, '_');
      const card = document.getElementById(`card-${safeId}`);
      if (card) card.classList.toggle('selected', this._selected.has(lock.entity_id));
    });

    const allBtn = document.getElementById('btn-select-all');
    if (allBtn) {
      const label = allBtn.querySelector('.btn-label');
      if (label) label.textContent = this._selected.size === this._locks.length ? 'Deselect All' : 'Select All';
    }
  },

  _toggleSelectAll() {
    if (this._selected.size === this._locks.length) {
      this._selected.clear();
    } else {
      this._locks.forEach(l => this._selected.add(l.entity_id));
    }
    document.querySelectorAll('input[data-select]').forEach(cb => {
      cb.checked = this._selected.has(cb.dataset.select);
    });
    this._updateSelectionUI();
  },

  async _batchAction(action) {
    const entities = [...this._selected];
    if (entities.length === 0) return;

    const label = action === 'lock' ? 'Lock' : 'Unlock';
    const count = entities.length;
    const plural = count > 1 ? 's' : '';

    if (action === 'lock') {
      // Simple confirm for locking
      const confirmed = await App.showConfirm(`Lock ${count} door${plural}?`);
      if (!confirmed) return;

      App.showToast(`Locking ${count} door${plural}...`);
      await this._executeBatchLockAction('lock', entities);
    } else {
      // Unlock: show duration picker in confirm dialog
      const result = await this._showUnlockConfirm(count);
      if (!result) return;

      if (result.duration === -1) {
        // "Until Re-Locked" — use the "Keep Unlocked" HA option
        App.showToast(`Unlocking ${count} door${plural} until re-locked...`);
        await this._executeBatchKeepUnlocked(entities);
      } else if (result.duration > 0) {
        App.showToast(`Unlocking ${count} door${plural} for ${result.duration} min...`);
        await this._executeBatchTimedUnlock(entities, result.duration);
      } else {
        App.showToast(`Unlocking ${count} door${plural}...`);
        await this._executeBatchLockAction('unlock', entities);
      }
    }

    this._selected.clear();
    this._updateSelectionUI();
    setTimeout(() => this._refreshLocks(), 500);
  },

  _showUnlockConfirm(doorCount) {
    return new Promise((resolve) => {
      document.getElementById('confirm-overlay')?.remove();

      const plural = doorCount > 1 ? 's' : '';
      const overlay = document.createElement('div');
      overlay.id = 'confirm-overlay';
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = `
        <div class="confirm-modal" style="max-width:380px;">
          <div class="confirm-message">Unlock ${doorCount} door${plural}?</div>
          <div style="margin:16px 0 8px;font-weight:600;font-size:14px;">Unlock duration:</div>
          <div class="duration-picker-row">
            <label class="duration-toggle-label">
              <input type="checkbox" id="batch-keep-unlocked">
              <span>Until re-locked</span>
            </label>
          </div>
          <div class="scroll-wheel-container" id="batch-wheels">
            <div class="scroll-wheel-group">
              <div class="scroll-wheel-label">Hours</div>
              <div class="scroll-wheel" id="batch-wheel-hours" data-wheel="hours"></div>
            </div>
            <div class="scroll-wheel-separator">:</div>
            <div class="scroll-wheel-group">
              <div class="scroll-wheel-label">Minutes</div>
              <div class="scroll-wheel" id="batch-wheel-minutes" data-wheel="minutes"></div>
            </div>
          </div>
          <div class="confirm-buttons">
            <button class="btn confirm-cancel">Cancel</button>
            <button class="btn confirm-ok btn-danger">Unlock</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const hoursWheel = overlay.querySelector('#batch-wheel-hours');
      const minutesWheel = overlay.querySelector('#batch-wheel-minutes');
      const keepCheck = overlay.querySelector('#batch-keep-unlocked');
      const wheelsContainer = overlay.querySelector('#batch-wheels');

      this._buildScrollWheel(hoursWheel, 0, 8, 1, 0);
      this._buildScrollWheel(minutesWheel, 0, 55, 5, 10);

      if (keepCheck) {
        keepCheck.addEventListener('change', () => {
          if (wheelsContainer) wheelsContainer.style.opacity = keepCheck.checked ? '0.3' : '1';
          if (wheelsContainer) wheelsContainer.style.pointerEvents = keepCheck.checked ? 'none' : '';
        });
      }

      overlay.querySelector('.confirm-cancel').addEventListener('click', () => {
        overlay.remove();
        resolve(null);
      });
      overlay.querySelector('.confirm-ok').addEventListener('click', () => {
        overlay.remove();
        if (keepCheck && keepCheck.checked) {
          resolve({ duration: -1 });
        } else {
          const h = this._getWheelValue(hoursWheel);
          const m = this._getWheelValue(minutesWheel);
          resolve({ duration: h * 60 + m });
        }
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(null); }
      });
    });
  },

  async _executeBatchLockAction(action, entities) {
    const promises = entities.map(eid =>
      fetch(`/api/ha/service/lock/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp',
        },
        body: JSON.stringify({ entity_id: eid }),
      }).catch(() => null)
    );
    await Promise.all(promises);
  },

  _findRuleOption(lock, keyword) {
    // Find the actual HA option string that contains the keyword (case-insensitive)
    if (!lock.lock_rule_options || !Array.isArray(lock.lock_rule_options)) return null;
    return lock.lock_rule_options.find(opt => opt.toLowerCase().includes(keyword.toLowerCase())) || null;
  },

  async _executeBatchTimedUnlock(entities, minutes) {
    // For each door that has a lock_rule_entity, use timed unlock;
    // for others, fall back to simple unlock
    const promises = entities.map(async (eid) => {
      const lock = this._locks.find(l => l.entity_id === eid);
      const customOption = lock ? this._findRuleOption(lock, 'custom') : null;
      if (lock && lock.duration_entity && lock.lock_rule_entity && customOption) {
        const durDomain = lock.duration_entity.split('.')[0];
        const ruleDomain = lock.lock_rule_entity.split('.')[0];
        // Set duration first, then trigger the custom rule
        await fetch(`/api/ha/service/${durDomain}/set_value`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: lock.duration_entity, value: minutes }),
        }).catch(() => null);
        await fetch(`/api/ha/service/${ruleDomain}/select_option`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: lock.lock_rule_entity, option: customOption }),
        }).catch(() => null);
      } else {
        // No rule entity — simple unlock
        await fetch('/api/ha/service/lock/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: eid }),
        }).catch(() => null);
      }
    });
    await Promise.all(promises);
  },

  async _executeBatchKeepUnlocked(entities) {
    // Use the "Keep Unlocked" HA option for each door
    const promises = entities.map(async (eid) => {
      const lock = this._locks.find(l => l.entity_id === eid);
      const keepOption = lock ? this._findRuleOption(lock, 'keep_unlock') : null;
      if (lock && lock.lock_rule_entity && keepOption) {
        const ruleDomain = lock.lock_rule_entity.split('.')[0];
        await fetch(`/api/ha/service/${ruleDomain}/select_option`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: lock.lock_rule_entity, option: keepOption }),
        }).catch(() => null);
      } else {
        // Fallback: simple unlock
        await fetch('/api/ha/service/lock/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: eid }),
        }).catch(() => null);
      }
    });
    await Promise.all(promises);
  },

  // --- Single-door panel ---

  _openDoorPanel(entityId) {
    const lock = this._locks.find(l => l.entity_id === entityId);
    if (!lock) return;

    App.showPanel(lock.friendly_name, (body) => {
      body.style.padding = '24px';
      body.innerHTML = this._doorPanelHTML(lock);
      this._wireDoorPanelEvents(body, lock);
      this._startPanelPolling(entityId);
    });

    const observer = new MutationObserver(() => {
      if (!document.getElementById('panel-overlay')) {
        this._stopPanelPolling();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  },

  _doorPanelHTML(lock) {
    const stateClass = this._doorStateClass(lock.state);
    const icon = lock.state === 'unlocked' || lock.state === 'open' ? 'lock_open' : 'lock';

    return `
      <div class="door-panel-status ${stateClass}">
        <span class="material-icons" style="font-size:64px;">${icon}</span>
        <div style="font-size:24px;font-weight:700;margin-top:12px;" id="panel-state-label">${this._doorStateLabel(lock.state)}</div>
        ${lock.door_open !== null ? `<div style="opacity:0.6;margin-top:4px;" id="panel-door-pos">${lock.door_open === 'on' ? 'Door is physically OPEN' : 'Door is CLOSED'}</div>` : ''}
        ${lock.changed_by ? `<div style="opacity:0.4;margin-top:4px;font-size:13px;">Last changed by: ${lock.changed_by}</div>` : ''}
      </div>

      <div style="display:flex;gap:12px;margin-top:24px;justify-content:center;flex-wrap:wrap;">
        <button class="btn btn-success btn-lg" id="panel-btn-lock" data-entity="${lock.entity_id}">
          <span class="material-icons">lock</span>
          <span class="btn-label">Lock</span>
        </button>
        <button class="btn btn-danger btn-lg" id="panel-btn-unlock" data-entity="${lock.entity_id}">
          <span class="material-icons">lock_open</span>
          <span class="btn-label">Unlock</span>
        </button>
      </div>

      ${lock.lock_rule_entity ? `
      <div class="door-panel-timed">
        <div style="font-weight:600;margin-bottom:10px;">Timed Unlock</div>
        <div class="duration-picker-row">
          <label class="duration-toggle-label">
            <input type="checkbox" id="panel-keep-unlocked">
            <span>Until re-locked</span>
          </label>
        </div>
        <div class="scroll-wheel-container" id="panel-wheels">
          <div class="scroll-wheel-group">
            <div class="scroll-wheel-label">Hours</div>
            <div class="scroll-wheel" id="panel-wheel-hours" data-wheel="hours"></div>
          </div>
          <div class="scroll-wheel-separator">:</div>
          <div class="scroll-wheel-group">
            <div class="scroll-wheel-label">Minutes</div>
            <div class="scroll-wheel" id="panel-wheel-minutes" data-wheel="minutes"></div>
          </div>
        </div>
        <button class="btn btn-warning btn-lg" id="panel-btn-timed" style="margin-top:12px;width:100%;">
          <span class="material-icons">timer</span>
          <span class="btn-label" id="timed-label">Unlock for 0h 10m</span>
        </button>
      </div>
      ` : `
      <div class="door-panel-timed">
        <div style="opacity:0.5;text-align:center;font-size:13px;margin-top:16px;">
          Timed unlock not available for this door (no lock rule entity found).
        </div>
      </div>
      `}
    `;
  },

  _wireDoorPanelEvents(body, lock) {
    body.querySelector('#panel-btn-lock')?.addEventListener('click', async () => {
      await this._callLockService('lock', lock.entity_id);
      App.closePanel();
      setTimeout(() => this._refreshLocks(), 500);
    });

    body.querySelector('#panel-btn-unlock')?.addEventListener('click', async () => {
      await this._callLockService('unlock', lock.entity_id);
      App.closePanel();
      setTimeout(() => this._refreshLocks(), 500);
    });

    // Scroll wheels for timed unlock
    const hoursWheel = body.querySelector('#panel-wheel-hours');
    const minutesWheel = body.querySelector('#panel-wheel-minutes');
    const keepCheck = body.querySelector('#panel-keep-unlocked');
    const wheelsContainer = body.querySelector('#panel-wheels');
    const timedLabel = body.querySelector('#timed-label');

    if (hoursWheel && minutesWheel) {
      this._buildScrollWheel(hoursWheel, 0, 8, 1, 0);
      this._buildScrollWheel(minutesWheel, 0, 55, 5, 10);

      const updateLabel = () => {
        if (!timedLabel) return;
        if (keepCheck && keepCheck.checked) {
          timedLabel.textContent = 'Keep Unlocked';
        } else {
          const h = this._getWheelValue(hoursWheel);
          const m = this._getWheelValue(minutesWheel);
          timedLabel.textContent = `Unlock for ${h}h ${m}m`;
        }
      };

      hoursWheel.addEventListener('wheel-change', updateLabel);
      minutesWheel.addEventListener('wheel-change', updateLabel);

      if (keepCheck) {
        keepCheck.addEventListener('change', () => {
          if (wheelsContainer) wheelsContainer.style.opacity = keepCheck.checked ? '0.3' : '1';
          if (wheelsContainer) wheelsContainer.style.pointerEvents = keepCheck.checked ? 'none' : '';
          updateLabel();
        });
      }
    }

    body.querySelector('#panel-btn-timed')?.addEventListener('click', async () => {
      if (!lock.lock_rule_entity) return;

      const ruleDomain = lock.lock_rule_entity.split('.')[0];

      if (keepCheck && keepCheck.checked) {
        const keepOption = this._findRuleOption(lock, 'keep_unlock');
        if (!keepOption) { App.showToast('Keep Unlock option not found', 'error'); return; }
        App.showToast(`Keeping ${lock.friendly_name} unlocked until re-locked...`);
        await fetch(`/api/ha/service/${ruleDomain}/select_option`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: lock.lock_rule_entity, option: keepOption }),
        }).catch(() => null);
      } else {
        const h = hoursWheel ? this._getWheelValue(hoursWheel) : 0;
        const m = minutesWheel ? this._getWheelValue(minutesWheel) : 10;
        const totalMinutes = h * 60 + m;
        if (totalMinutes === 0) { App.showToast('Select a duration', 'error'); return; }
        const customOption = this._findRuleOption(lock, 'custom');
        if (!customOption || !lock.duration_entity) { App.showToast('Timed unlock not available', 'error'); return; }
        App.showToast(`Unlocking ${lock.friendly_name} for ${h}h ${m}m...`);
        const durDomain = lock.duration_entity.split('.')[0];
        await fetch(`/api/ha/service/${durDomain}/set_value`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: lock.duration_entity, value: totalMinutes }),
        }).catch(() => null);
        await fetch(`/api/ha/service/${ruleDomain}/select_option`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ entity_id: lock.lock_rule_entity, option: customOption }),
        }).catch(() => null);
      }

      App.closePanel();
      setTimeout(() => this._refreshLocks(), 1000);
    });
  },

  async _callLockService(action, entityId) {
    const label = action === 'lock' ? 'Locking' : 'Unlocking';
    const lock = this._locks.find(l => l.entity_id === entityId);
    App.showToast(`${label} ${lock ? lock.friendly_name : entityId}...`);

    try {
      await fetch(`/api/ha/service/lock/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
        body: JSON.stringify({ entity_id: entityId }),
      });
    } catch (e) {
      App.showToast('Failed to reach gateway', 'error');
    }
  },

  // --- Lock polling ---

  _startLockPolling() {
    this._lockPollTimer = setInterval(() => this._refreshLocks(), 2000);
  },

  _stopLockPolling() {
    if (this._lockPollTimer) { clearInterval(this._lockPollTimer); this._lockPollTimer = null; }
    this._stopPanelPolling();
  },

  async _refreshLocks() {
    try {
      const resp = await fetch('/api/ha/locks', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const data = await resp.json();
      if (data.locks) this._updateLockStates(data.locks);
    } catch (e) { /* silent */ }
  },

  _startPanelPolling(entityId) {
    this._stopPanelPolling();
    this._panelPollTimer = setInterval(async () => {
      try {
        const resp = await fetch(`/api/ha/states/lock.${entityId.replace('lock.', '')}`, {
          headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
        });
        const state = await resp.json();
        const stateLabel = document.getElementById('panel-state-label');
        if (stateLabel) stateLabel.textContent = this._doorStateLabel(state.state);
      } catch (e) { /* silent */ }
    }, 2000);
  },

  _stopPanelPolling() {
    if (this._panelPollTimer) { clearInterval(this._panelPollTimer); this._panelPollTimer = null; }
  },

  // --- Door state helpers ---

  _doorStateClass(state) {
    switch (state) {
      case 'locked': return 'door-locked';
      case 'unlocked': case 'open': return 'door-unlocked';
      case 'locking': case 'unlocking': case 'opening': return 'door-transitioning';
      case 'jammed': return 'door-jammed';
      default: return 'door-unknown';
    }
  },

  _doorStateLabel(state) {
    switch (state) {
      case 'locked': return 'LOCKED';
      case 'unlocked': return 'UNLOCKED';
      case 'locking': return 'LOCKING...';
      case 'unlocking': return 'UNLOCKING...';
      case 'open': return 'OPEN';
      case 'opening': return 'OPENING...';
      case 'jammed': return 'JAMMED';
      default: return state ? state.toUpperCase() : 'UNKNOWN';
    }
  },

  // ===========================================================================
  // Scroll Wheel Duration Picker
  // ===========================================================================

  _buildScrollWheel(container, min, max, step, defaultVal) {
    if (!container) return;
    const values = [];
    for (let v = min; v <= max; v += step) values.push(v);

    const ITEM_H = 40;
    const VISIBLE = 3;

    container.innerHTML = `
      <div class="sw-viewport" style="height:${ITEM_H * VISIBLE}px;overflow:hidden;position:relative;">
        <div class="sw-track" style="position:absolute;width:100%;transition:transform 0.15s ease-out;"></div>
        <div class="sw-highlight" style="position:absolute;top:${ITEM_H}px;left:0;right:0;height:${ITEM_H}px;
          border-top:2px solid var(--accent);border-bottom:2px solid var(--accent);pointer-events:none;"></div>
      </div>
      <div class="sw-arrows" style="display:flex;justify-content:space-between;margin-top:4px;">
        <button class="btn btn-sm sw-up" style="flex:1;min-height:32px;"><span class="material-icons" style="font-size:18px;">expand_less</span></button>
        <button class="btn btn-sm sw-down" style="flex:1;min-height:32px;margin-left:4px;"><span class="material-icons" style="font-size:18px;">expand_more</span></button>
      </div>
    `;

    const track = container.querySelector('.sw-track');
    // Pad with empty items top and bottom so the first and last values can center
    const padded = ['', ...values.map(String), ''];
    track.innerHTML = padded.map(v =>
      `<div class="sw-item" style="height:${ITEM_H}px;line-height:${ITEM_H}px;text-align:center;font-size:20px;font-weight:600;user-select:none;">${v}</div>`
    ).join('');

    let idx = values.indexOf(defaultVal);
    if (idx === -1) idx = 0;
    container._swValues = values;
    container._swIndex = idx;

    const setPos = (i, animate) => {
      i = Math.max(0, Math.min(values.length - 1, i));
      container._swIndex = i;
      track.style.transition = animate ? 'transform 0.15s ease-out' : 'none';
      track.style.transform = `translateY(${-i * ITEM_H}px)`;
      // Style items: bold/dim based on selection
      const items = track.querySelectorAll('.sw-item');
      items.forEach((el, elIdx) => {
        const valueIdx = elIdx - 1; // offset by 1 for top pad
        el.style.opacity = valueIdx === i ? '1' : '0.3';
      });
      container.dispatchEvent(new Event('wheel-change'));
    };
    setPos(idx, false);

    container.querySelector('.sw-up').addEventListener('click', () => setPos(container._swIndex - 1, true));
    container.querySelector('.sw-down').addEventListener('click', () => setPos(container._swIndex + 1, true));

    // Touch/mouse drag support
    let startY = 0, startIdx = 0, dragging = false;
    const viewport = container.querySelector('.sw-viewport');

    const onStart = (y) => { startY = y; startIdx = container._swIndex; dragging = true; };
    const onMove = (y) => {
      if (!dragging) return;
      const delta = Math.round((startY - y) / ITEM_H);
      if (delta !== 0) { setPos(startIdx + delta, false); }
    };
    const onEnd = () => { dragging = false; };

    viewport.addEventListener('touchstart', (e) => onStart(e.touches[0].clientY), { passive: true });
    viewport.addEventListener('touchmove', (e) => onMove(e.touches[0].clientY), { passive: true });
    viewport.addEventListener('touchend', onEnd);
    viewport.addEventListener('mousedown', (e) => { e.preventDefault(); onStart(e.clientY); });
    document.addEventListener('mousemove', (e) => onMove(e.clientY));
    document.addEventListener('mouseup', onEnd);

    // Mouse wheel scroll
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      setPos(container._swIndex + (e.deltaY > 0 ? 1 : -1), true);
    }, { passive: false });
  },

  _getWheelValue(container) {
    if (!container || !container._swValues) return 0;
    return container._swValues[container._swIndex] || 0;
  },

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  _stopAllFeeds() {
    Object.values(this._feedTimers).forEach(t => clearTimeout(t));
    this._feedTimers = {};
  },

  destroy() {
    this._stopAllFeeds();
    this._stopLockPolling();
    this._selected.clear();
  }
};
