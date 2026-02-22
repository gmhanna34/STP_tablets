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

  async execute(macroKey, skipSteps = []) {
    try {
      const body = { macro: macroKey };
      if (skipSteps.length > 0) body.skip_steps = skipSteps;
      const resp = await fetch('/api/macro/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000), // macros can take up to 60s
      });
      return await resp.json();
    } catch (e) {
      console.error('MacroAPI.execute:', e);
      return { success: false, error: String(e) };
    }
  },

  async expandMacro(macroKey) {
    try {
      const resp = await fetch(`/api/macro/expand/${encodeURIComponent(macroKey)}`, {
        headers: { 'X-Tablet-ID': this.tabletId },
        signal: AbortSignal.timeout(5000),
      });
      return await resp.json();
    } catch (e) {
      console.error('MacroAPI.expandMacro:', e);
      return null;
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

    container.innerHTML = sections.map(section => {
      const isCollapsed = section.collapsed === true;
      const collapseClass = isCollapsed ? ' collapsed' : '';
      const toggleAttr = isCollapsed ? ' data-collapsible="true"' : '';

      return `
      <div class="control-section${collapseClass}"${toggleAttr}>
        <div class="section-title${isCollapsed ? ' section-title-toggle' : ''}">${section.section || ''}${isCollapsed ? '<span class="material-icons section-toggle-icon">expand_more</span>' : ''}</div>
        <div class="control-grid${isCollapsed ? ' section-content-collapsed' : ''}">
          ${(section.items || []).map((item, idx) => {
            const spanStyle = item.span ? `grid-column: span ${item.span};` : '';
            const styleClasses = this._resolveStyleClasses(item);
            const stateActive = this.resolveState(item.state);
            const stateClass = stateActive === true ? (item.state?.on_style || 'active') : '';
            const confirmAttr = this._resolveConfirm(item, macros);
            const confirmSteps = item.confirm_steps ? ' data-confirm-steps="true"' : '';

            return `<button class="btn ${styleClasses} ${stateClass}"
                      data-macro-btn="${idx}"
                      data-section="${section.section || ''}"
                      ${confirmAttr ? `data-confirm="${this._escapeHtml(confirmAttr)}"` : ''}
                      ${confirmSteps}
                      style="${spanStyle}">
              ${item.icon ? `<span class="material-icons">${item.icon}</span>` : ''}
              <span class="btn-label">${item.label || ''}</span>
            </button>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    // Attach collapsible section toggle handlers
    container.querySelectorAll('.section-title-toggle').forEach(title => {
      title.addEventListener('click', () => {
        const section = title.closest('.control-section');
        const grid = section.querySelector('.control-grid');
        const icon = title.querySelector('.section-toggle-icon');
        section.classList.toggle('collapsed');
        grid.classList.toggle('section-content-collapsed');
        if (icon) icon.textContent = section.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
      });
    });

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

    // Step confirmation: show expanded step list with checkboxes
    if (btn.dataset.confirmSteps === 'true' && action.type === 'macro') {
      const result = await this.showStepConfirm(action.macro, btn.dataset.confirm || '');
      if (!result.confirmed) return;

      btn.classList.add('loading');
      btn.disabled = true;
      try {
        const execResult = await this.execute(action.macro, result.skipSteps);
        if (execResult && execResult.success) {
          App.showToast(`${item.label || action.macro}: Done`, 2000);
        } else if (execResult && execResult.error) {
          App.showToast(`${item.label}: ${execResult.error}`, 4000, 'error');
        }
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
      return;
    }

    // Simple confirmation check
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

  // -----------------------------------------------------------------------
  // Step confirmation modal — shows macro steps as checkboxes
  // -----------------------------------------------------------------------

  async showStepConfirm(macroKey, confirmMessage) {
    const expanded = await this.expandMacro(macroKey);
    if (!expanded || !expanded.steps) {
      // Fallback to simple confirm
      const ok = confirmMessage ? await App.showConfirm(confirmMessage) : true;
      return { confirmed: ok, skipSteps: [] };
    }

    return new Promise((resolve) => {
      document.getElementById('step-confirm-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'step-confirm-overlay';
      overlay.className = 'confirm-overlay';

      const title = confirmMessage || `Execute ${expanded.label}?`;
      const stepsHtml = this._renderStepTree(expanded.steps, '');

      overlay.innerHTML = `
        <div class="step-confirm-modal">
          <div class="step-confirm-title">${this._escapeHtml(title)}</div>
          <div class="step-confirm-list">${stepsHtml}</div>
          <div class="confirm-buttons">
            <button class="btn confirm-cancel">Cancel</button>
            <button class="btn confirm-ok btn-success">Execute</button>
          </div>
        </div>
      `;

      // Group checkbox logic: toggling a parent toggles all children
      overlay.querySelectorAll('.step-group-checkbox').forEach(groupCb => {
        groupCb.addEventListener('change', () => {
          const group = groupCb.closest('.step-group');
          group.querySelectorAll('.step-child-checkbox').forEach(childCb => {
            childCb.checked = groupCb.checked;
          });
        });
      });

      // Child checkbox: if all children unchecked, uncheck parent
      overlay.querySelectorAll('.step-child-checkbox').forEach(childCb => {
        childCb.addEventListener('change', () => {
          const group = childCb.closest('.step-group');
          const groupCb = group.querySelector('.step-group-checkbox');
          const children = group.querySelectorAll('.step-child-checkbox');
          const anyChecked = Array.from(children).some(c => c.checked);
          groupCb.checked = anyChecked;
        });
      });

      const cleanup = (result) => {
        overlay.remove();
        resolve(result);
      };

      overlay.querySelector('.confirm-cancel').addEventListener('click', () => {
        cleanup({ confirmed: false, skipSteps: [] });
      });

      overlay.querySelector('.confirm-ok').addEventListener('click', () => {
        // Collect unchecked step paths
        const skipSteps = [];
        overlay.querySelectorAll('input[data-step-path]').forEach(cb => {
          if (!cb.checked) skipSteps.push(cb.dataset.stepPath);
        });
        cleanup({ confirmed: true, skipSteps });
      });

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) cleanup({ confirmed: false, skipSteps: [] });
      });

      document.body.appendChild(overlay);
    });
  },

  _renderStepTree(steps, prefix) {
    return steps.map(step => {
      const path = prefix ? `${prefix}${step.index}` : `${step.index}`;
      const label = this._escapeHtml(step.label || `Step ${step.index + 1}`);

      if (step.children && step.children.length > 0) {
        const childPrefix = `${path}.`;
        const childrenHtml = step.children.map(child => {
          const childPath = `${childPrefix}${child.index}`;
          const childLabel = this._escapeHtml(child.label || `Step ${child.index + 1}`);
          return `<label class="step-child">
            <input type="checkbox" checked class="step-child-checkbox" data-step-path="${childPath}">
            <span class="step-type-badge">${child.type}</span>
            <span>${childLabel}</span>
          </label>`;
        }).join('');

        return `<div class="step-group">
          <label class="step-parent">
            <input type="checkbox" checked class="step-group-checkbox" data-step-path="${path}">
            <span class="step-type-badge">${step.type}</span>
            <strong>${step.child_label || label}</strong>
          </label>
          <div class="step-children">${childrenHtml}</div>
        </div>`;
      }

      return `<label class="step-item">
        <input type="checkbox" checked data-step-path="${path}">
        <span class="step-type-badge">${step.type}</span>
        <span>${label}</span>
      </label>`;
    }).join('');
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
