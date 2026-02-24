const AccessControlPage = {
  _locks: [],
  _selected: new Set(),
  _pollTimer: null,
  _panelPollTimer: null,

  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>ACCESS CONTROL</h1>
        <div class="subtitle">Door Management</div>
      </div>

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
    `;
  },

  async init() {
    this._selected = new Set();

    // Batch bar buttons
    document.getElementById('btn-select-all')?.addEventListener('click', () => this._toggleSelectAll());
    document.getElementById('btn-batch-lock')?.addEventListener('click', () => this._batchAction('lock'));
    document.getElementById('btn-batch-unlock')?.addEventListener('click', () => this._batchAction('unlock'));

    await this._loadLocks();
    this._startPolling();
  },

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------

  async _loadLocks() {
    try {
      const resp = await fetch('/api/ha/locks', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const data = await resp.json();
      this._locks = data.locks || [];
    } catch (e) {
      const grid = document.getElementById('door-grid');
      if (grid) grid.innerHTML = '<div style="color:var(--danger);text-align:center;padding:40px;grid-column:1/-1;">Failed to load doors from Home Assistant.</div>';
      return;
    }

    if (this._locks.length === 0) {
      const grid = document.getElementById('door-grid');
      if (grid) grid.innerHTML = '<div style="opacity:0.5;text-align:center;padding:40px;grid-column:1/-1;">No lock entities found in Home Assistant.</div>';
      return;
    }

    this._renderGrid();
  },

  _renderGrid() {
    const grid = document.getElementById('door-grid');
    if (!grid) return;

    grid.innerHTML = this._locks.map(lock => {
      const safeId = lock.entity_id.replace(/\./g, '_');
      const stateClass = this._stateClass(lock.state);
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
            <div class="door-status">${this._stateLabel(lock.state)}</div>
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

    // Wire card click (opens panel)
    grid.querySelectorAll('[data-door-click]').forEach(el => {
      el.addEventListener('click', () => {
        this._openDoorPanel(el.dataset.doorClick);
      });
    });

    this._updateSelectionUI();
  },

  _updateLockStates(newLocks) {
    // Update in-place without full re-render
    for (const lock of newLocks) {
      const existing = this._locks.find(l => l.entity_id === lock.entity_id);
      if (!existing) { this._locks = newLocks; this._renderGrid(); return; }
      if (existing.state === lock.state && existing.door_open === lock.door_open) continue;

      existing.state = lock.state;
      existing.door_open = lock.door_open;
      existing.changed_by = lock.changed_by;

      const safeId = lock.entity_id.replace(/\./g, '_');
      const card = document.getElementById(`card-${safeId}`);
      if (!card) continue;

      // Update class
      card.className = `door-card ${this._stateClass(lock.state)}${this._selected.has(lock.entity_id) ? ' selected' : ''}`;

      // Update icon
      const iconEl = card.querySelector('.door-icon');
      if (iconEl) iconEl.textContent = (lock.state === 'unlocked' || lock.state === 'open') ? 'lock_open' : 'lock';

      // Update status text
      const statusEl = card.querySelector('.door-status');
      if (statusEl) statusEl.textContent = this._stateLabel(lock.state);

      // Update door position
      const posEl = card.querySelector('.door-position');
      if (posEl) posEl.textContent = lock.door_open === 'on' ? 'Door Open' : '';
    }
  },

  // ---------------------------------------------------------------------------
  // Selection & batch actions
  // ---------------------------------------------------------------------------

  _updateSelectionUI() {
    const bar = document.getElementById('batch-bar');
    const count = document.getElementById('batch-count');
    if (bar) bar.style.display = this._selected.size > 0 ? '' : 'none';
    if (count) count.textContent = `${this._selected.size} selected`;

    // Update card visual selection state
    this._locks.forEach(lock => {
      const safeId = lock.entity_id.replace(/\./g, '_');
      const card = document.getElementById(`card-${safeId}`);
      if (card) card.classList.toggle('selected', this._selected.has(lock.entity_id));
    });

    // Update select-all button label
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
    // Update checkboxes
    document.querySelectorAll('input[data-select]').forEach(cb => {
      cb.checked = this._selected.has(cb.dataset.select);
    });
    this._updateSelectionUI();
  },

  async _batchAction(action) {
    const entities = [...this._selected];
    if (entities.length === 0) return;

    const label = action === 'lock' ? 'Lock' : 'Unlock';
    const confirmed = await App.showConfirm(
      `${label} ${entities.length} door${entities.length > 1 ? 's' : ''}?`
    );
    if (!confirmed) return;

    App.showToast(`${label}ing ${entities.length} door${entities.length > 1 ? 's' : ''}...`);

    // Fire all in parallel
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

    this._selected.clear();
    this._updateSelectionUI();
    // Immediate refresh to show transitioning states
    setTimeout(() => this._refreshLocks(), 500);
  },

  // ---------------------------------------------------------------------------
  // Single-door panel
  // ---------------------------------------------------------------------------

  _openDoorPanel(entityId) {
    const lock = this._locks.find(l => l.entity_id === entityId);
    if (!lock) return;

    App.showPanel(lock.friendly_name, (body) => {
      body.style.padding = '24px';
      body.innerHTML = this._panelHTML(lock);
      this._wirePanelEvents(body, lock);
      this._startPanelPolling(entityId);
    });

    // Stop panel polling when panel closes
    const observer = new MutationObserver(() => {
      if (!document.getElementById('panel-overlay')) {
        this._stopPanelPolling();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  },

  _panelHTML(lock) {
    const stateClass = this._stateClass(lock.state);
    const icon = lock.state === 'unlocked' || lock.state === 'open' ? 'lock_open' : 'lock';

    return `
      <div class="door-panel-status ${stateClass}">
        <span class="material-icons" style="font-size:64px;">${icon}</span>
        <div style="font-size:24px;font-weight:700;margin-top:12px;" id="panel-state-label">${this._stateLabel(lock.state)}</div>
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
        <div class="duration-chips">
          <button class="btn btn-sm duration-chip" data-minutes="5">5 min</button>
          <button class="btn btn-sm duration-chip" data-minutes="10">10 min</button>
          <button class="btn btn-sm duration-chip" data-minutes="15">15 min</button>
          <button class="btn btn-sm duration-chip" data-minutes="30">30 min</button>
          <button class="btn btn-sm duration-chip" data-minutes="60">1 hr</button>
        </div>
        <button class="btn btn-warning btn-lg" id="panel-btn-timed" style="margin-top:12px;width:100%;">
          <span class="material-icons">timer</span>
          <span class="btn-label" id="timed-label">Unlock for 10 min</span>
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

  _wirePanelEvents(body, lock) {
    let selectedMinutes = 10;

    // Lock / Unlock buttons
    body.querySelector('#panel-btn-lock')?.addEventListener('click', async () => {
      await this._callLockService('lock', lock.entity_id);
      setTimeout(() => this._refreshLocks(), 500);
    });

    body.querySelector('#panel-btn-unlock')?.addEventListener('click', async () => {
      await this._callLockService('unlock', lock.entity_id);
      setTimeout(() => this._refreshLocks(), 500);
    });

    // Duration chips
    body.querySelectorAll('.duration-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        selectedMinutes = parseInt(chip.dataset.minutes, 10);
        body.querySelectorAll('.duration-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        const label = body.querySelector('#timed-label');
        if (label) label.textContent = `Unlock for ${selectedMinutes >= 60 ? (selectedMinutes / 60) + ' hr' : selectedMinutes + ' min'}`;
      });
    });

    // Default selection (10 min)
    const default10 = body.querySelector('.duration-chip[data-minutes="10"]');
    if (default10) default10.classList.add('active');

    // Timed unlock button
    body.querySelector('#panel-btn-timed')?.addEventListener('click', async () => {
      if (!lock.duration_entity || !lock.lock_rule_entity) return;

      App.showToast(`Unlocking ${lock.friendly_name} for ${selectedMinutes} min...`);

      // 1. Set the duration
      await fetch('/api/ha/service/input_number/set_value', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp',
        },
        body: JSON.stringify({ entity_id: lock.duration_entity, value: selectedMinutes }),
      }).catch(() => null);

      // 2. Select the "custom" rule to trigger timed unlock
      await fetch('/api/ha/service/input_select/select_option', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp',
        },
        body: JSON.stringify({ entity_id: lock.lock_rule_entity, option: 'custom' }),
      }).catch(() => null);

      setTimeout(() => this._refreshLocks(), 1000);
    });
  },

  // ---------------------------------------------------------------------------
  // API calls
  // ---------------------------------------------------------------------------

  async _callLockService(action, entityId) {
    const label = action === 'lock' ? 'Locking' : 'Unlocking';
    const lock = this._locks.find(l => l.entity_id === entityId);
    App.showToast(`${label} ${lock ? lock.friendly_name : entityId}...`);

    try {
      await fetch(`/api/ha/service/lock/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp',
        },
        body: JSON.stringify({ entity_id: entityId }),
      });
    } catch (e) {
      App.showToast('Failed to reach gateway', 'error');
    }
  },

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  _startPolling() {
    this._pollTimer = setInterval(() => this._refreshLocks(), 5000);
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
        // Update panel display
        const stateLabel = document.getElementById('panel-state-label');
        if (stateLabel) stateLabel.textContent = this._stateLabel(state.state);
      } catch (e) { /* silent */ }
    }, 2000);
  },

  _stopPanelPolling() {
    if (this._panelPollTimer) { clearInterval(this._panelPollTimer); this._panelPollTimer = null; }
  },

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  _stateClass(state) {
    switch (state) {
      case 'locked': return 'door-locked';
      case 'unlocked': case 'open': return 'door-unlocked';
      case 'locking': case 'unlocking': case 'opening': return 'door-transitioning';
      case 'jammed': return 'door-jammed';
      default: return 'door-unknown';
    }
  },

  _stateLabel(state) {
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

  destroy() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    this._stopPanelPolling();
    this._selected.clear();
  }
};
