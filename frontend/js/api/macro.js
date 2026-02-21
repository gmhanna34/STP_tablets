// Macro API Service — executes macros and renders dynamic button layouts
const MacroAPI = {
  _buttonCache: {},
  _stateCache: {},
  _stateListeners: [],

  init() {
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
    // Listen for state updates from all subsystems
    if (App.socket) {
      this._bindSocketEvents(App.socket);
    }
  },

  _bindSocketEvents(socket) {
    socket.on('state:ha', (data) => { this._stateCache.ha = data; this._notifyListeners(); });
    socket.on('state:obs', (data) => { this._stateCache.obs = data; this._notifyListeners(); });
    socket.on('state:x32', (data) => { this._stateCache.x32 = data; this._notifyListeners(); });
    socket.on('state:projectors', (data) => { this._stateCache.projectors = data; this._notifyListeners(); });
    socket.on('state:moip', (data) => { this._stateCache.moip = data; this._notifyListeners(); });

    // Macro progress events
    socket.on('macro:progress', (data) => {
      if (!data) return;
      const { label, status, steps_completed, steps_total, error, current_step } = data;
      if (status === 'completed') {
        App.showToast(`${label}: Complete`, 2000);
      } else if (status === 'failed') {
        App.showToast(`${label}: FAILED — ${error || 'unknown error'}`, 4000, 'error');
      } else if (status === 'in_progress' && current_step) {
        App.showToast(`${label}: ${current_step}`, 1500);
      }
    });

    // Join the macros room for progress events
    socket.emit('join', { room: 'macros' });
  },

  _notifyListeners() {
    for (const fn of this._stateListeners) {
      try { fn(this._stateCache); } catch (e) { /* ignore */ }
    }
  },

  onStateChange(fn) {
    this._stateListeners.push(fn);
  },

  removeStateListener(fn) {
    this._stateListeners = this._stateListeners.filter(f => f !== fn);
  },

  // -----------------------------------------------------------------------
  // API calls
  // -----------------------------------------------------------------------

  async getButtons(page) {
    try {
      const resp = await fetch(`/api/macros?page=${page}`, {
        headers: { 'X-Tablet-ID': this.tabletId },
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      this._buttonCache[page] = data.buttons || [];
      return data;
    } catch (e) {
      console.error('MacroAPI.getButtons:', e);
      return { buttons: [], macros: {} };
    }
  },

  async execute(macroKey) {
    try {
      const resp = await fetch('/api/macro/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ macro: macroKey }),
        signal: AbortSignal.timeout(60000), // macros can take up to 60s
      });
      return await resp.json();
    } catch (e) {
      console.error('MacroAPI.execute:', e);
      return { success: false, error: String(e) };
    }
  },

  async fetchState() {
    try {
      const resp = await fetch('/api/macro/state', {
        headers: { 'X-Tablet-ID': this.tabletId },
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      Object.assign(this._stateCache, data);
      return data;
    } catch (e) {
      console.error('MacroAPI.fetchState:', e);
      return {};
    }
  },

  // -----------------------------------------------------------------------
  // State resolution — check if a button's state binding is "on"
  // -----------------------------------------------------------------------

  resolveState(stateBinding) {
    if (!stateBinding) return null;
    const { source, entity, field, on_value } = stateBinding;

    if (source === 'ha') {
      const haStates = this._stateCache.ha || {};
      const entityState = haStates[entity];
      if (!entityState) return null;
      return String(entityState.state) === String(on_value);
    }

    // For obs, x32, projectors, moip — resolve dot-path in cached state
    const sourceData = this._stateCache[source];
    if (!sourceData || !field) return null;

    const value = field.split('.').reduce((obj, key) => obj && obj[key], sourceData);
    if (value === undefined) return null;
    return String(value) === String(on_value);
  },

  // -----------------------------------------------------------------------
  // Dynamic button renderer
  // -----------------------------------------------------------------------

  renderButtons(container, sections, macros) {
    if (!sections || sections.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = sections.map(section => `
      <div class="control-section">
        <div class="section-title">${section.section || ''}</div>
        <div class="control-grid">
          ${(section.items || []).map((item, idx) => {
            const spanStyle = item.span ? `grid-column: span ${item.span};` : '';
            const styleClasses = this._resolveStyleClasses(item);
            const stateActive = this.resolveState(item.state);
            const stateClass = stateActive === true ? (item.state?.on_style || 'active') : '';
            const confirmAttr = this._resolveConfirm(item, macros);

            return `<button class="btn ${styleClasses} ${stateClass}"
                      data-macro-btn="${idx}"
                      data-section="${section.section || ''}"
                      ${confirmAttr ? `data-confirm="${this._escapeHtml(confirmAttr)}"` : ''}
                      style="${spanStyle}">
              ${item.icon ? `<span class="material-icons">${item.icon}</span>` : ''}
              <span class="btn-label">${item.label || ''}</span>
            </button>`;
          }).join('')}
        </div>
      </div>
    `).join('');

    // Attach click handlers
    container.querySelectorAll('[data-macro-btn]').forEach(btn => {
      const sectionName = btn.dataset.section;
      const idx = parseInt(btn.dataset.macroBtnIdx || btn.dataset.macroBtn);
      const section = sections.find(s => s.section === sectionName);
      if (!section) return;
      const item = section.items[idx];
      if (!item) return;

      btn.addEventListener('click', async () => {
        await this._handleButtonClick(btn, item);
      });
    });
  },

  async _handleButtonClick(btn, item) {
    const action = item.action;
    if (!action) return;

    // Confirmation check
    const confirmMsg = btn.dataset.confirm;
    if (confirmMsg) {
      if (!await App.showConfirm(confirmMsg)) return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      if (action.type === 'macro') {
        const result = await this.execute(action.macro);
        if (result && result.success) {
          App.showToast(`${item.label || action.macro}: Done`, 2000);
        } else if (result && result.error) {
          App.showToast(`${item.label}: ${result.error}`, 4000, 'error');
        }

      } else if (action.type === 'moip_switch') {
        await MoIPAPI.switchSource(String(action.tx), String(action.rx));
        App.showToast(item.label || 'Source switched');

      } else if (action.type === 'ha_service') {
        const resp = await fetch(`/api/ha/service/${action.domain}/${action.service}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': this.tabletId },
          body: JSON.stringify(action.data || {}),
        });
        App.showToast(item.label || 'HA service called');

      } else if (action.type === 'navigate') {
        Router.navigate(action.page);

      } else {
        console.warn('Unknown button action type:', action.type);
      }
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  },

  _resolveStyleClasses(item) {
    const style = item.style || '';
    if (Array.isArray(style)) return style.map(s => `btn-${s}`).join(' ');
    return style.split(' ').filter(Boolean).map(s => `btn-${s}`).join(' ');
  },

  _resolveConfirm(item, macros) {
    // Item-level confirm overrides macro-level
    if (item.confirm) return item.confirm;
    if (item.action?.type === 'macro' && item.action?.macro) {
      const m = macros?.[item.action.macro];
      if (m && m.confirm) return m.confirm;
    }
    return '';
  },

  _escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  },

  // -----------------------------------------------------------------------
  // Update button states (called when state changes arrive)
  // -----------------------------------------------------------------------

  updateButtonStates(container, sections) {
    if (!sections || !container) return;

    container.querySelectorAll('[data-macro-btn]').forEach(btn => {
      const sectionName = btn.dataset.section;
      const idx = parseInt(btn.dataset.macroBtn);
      const section = sections.find(s => s.section === sectionName);
      if (!section) return;
      const item = section.items[idx];
      if (!item || !item.state) return;

      const stateActive = this.resolveState(item.state);
      const onStyle = item.state.on_style || 'active';

      if (stateActive === true) {
        btn.classList.add(onStyle);
      } else {
        btn.classList.remove(onStyle);
      }
    });
  }
};
