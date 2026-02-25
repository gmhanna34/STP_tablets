// Macro API Service — executes macros and renders dynamic button layouts
const MacroAPI = {
  _buttonCache: {},
  _stateCache: {},
  _stateListeners: [],
  _longPressDelay: 800,

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

  // Resolve raw value from state cache (for badges and disabled_when)
  resolveValue(binding) {
    if (!binding) return null;
    const { source, entity, field, attribute } = binding;

    if (source === 'ha') {
      const haStates = this._stateCache.ha || {};
      const entityState = haStates[entity];
      if (!entityState) return null;
      if (attribute) return entityState.attributes?.[attribute];
      return entityState.state;
    }

    const sourceData = this._stateCache[source];
    if (!sourceData || !field) return null;
    return field.split('.').reduce((obj, key) => obj && obj[key], sourceData);
  },

  // Check disabled_when condition — returns true if button should be disabled
  _checkDisabledWhen(condition) {
    if (!condition) return false;
    const currentValue = this.resolveValue(condition);
    if (currentValue === null || currentValue === undefined) return false;
    return String(currentValue) === String(condition.value);
  },

  // Format a badge value for display
  _formatBadge(value, format) {
    if (value === null || value === undefined) return '--';
    switch (format) {
      case 'temp': return `${Math.round(Number(value))}\u00B0F`;
      case 'percent': return `${Math.round(Number(value))}%`;
      case 'duration': {
        const secs = Number(value);
        if (isNaN(secs)) return String(value);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = Math.floor(secs % 60);
        return h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${m}:${String(s).padStart(2, '0')}`;
      }
      default: return String(value);
    }
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
      const collapseAttr = isCollapsed ? ' data-collapsible="true"' : '';
      const sectionDisabled = this._checkDisabledWhen(section.disabled_when);

      return `
      <div class="control-section${collapseClass}"${collapseAttr}>
        <div class="section-title${isCollapsed ? ' section-title-toggle' : ''}">${section.section || ''}${isCollapsed ? '<span class="material-icons section-toggle-icon">expand_more</span>' : ''}</div>
        <div class="control-grid${isCollapsed ? ' section-content-collapsed' : ''}">
          ${(section.items || []).map((item, idx) => {
            const spanStyle = item.span ? `grid-column: span ${item.span};` : '';

            // Toggle buttons: resolve current appearance from state
            let label = item.label || '';
            let icon = item.icon || '';
            let styleClasses = this._resolveStyleClasses(item);
            let stateClass = '';
            let confirmAttr = this._resolveConfirm(item, macros);
            let confirmSteps = item.confirm_steps ? ' data-confirm-steps="true"' : '';
            let isToggle = '';
            let badgeHtml = '';
            let longPressAttr = '';

            if (item.toggle) {
              const isOn = this.resolveState(item.toggle.state);
              const resolved = isOn ? item.toggle.on : item.toggle.off;
              label = resolved.label || label;
              icon = resolved.icon || icon;
              if (resolved.style) {
                styleClasses = resolved.style.split(' ').filter(Boolean).map(s => `btn-${s}`).join(' ');
              } else {
                styleClasses = '';
              }
              if (isOn && item.toggle.state?.on_style) {
                stateClass = item.toggle.state.on_style;
              }
              confirmAttr = resolved.confirm || '';
              if (resolved.confirm_steps) confirmSteps = ' data-confirm-steps="true"';
              isToggle = ' data-toggle="true"';
            } else {
              const stateActive = this.resolveState(item.state);
              stateClass = stateActive === true ? (item.state?.on_style || 'active') : '';
            }

            // Badge
            if (item.badge) {
              const val = this.resolveValue(item.badge);
              const formatted = this._formatBadge(val, item.badge.format);
              badgeHtml = `<span class="btn-badge">${formatted}</span>`;
            }

            // Long press
            if (item.long_press) longPressAttr = ' data-long-press="true"';

            // Disabled (section-level or button-level)
            const btnDisabled = sectionDisabled || this._checkDisabledWhen(item.disabled_when);
            const disabledAttr = btnDisabled ? ' disabled' : '';
            const disabledClass = btnDisabled ? ' btn-disabled-state' : '';

            return `<button class="btn ${styleClasses} ${stateClass}${disabledClass}"
                      data-macro-btn="${idx}"
                      data-section="${this._escapeHtml(section.section || '')}"
                      ${confirmAttr ? `data-confirm="${this._escapeHtml(confirmAttr)}"` : ''}
                      ${confirmSteps}${isToggle}${longPressAttr}${disabledAttr}
                      style="${spanStyle}">
              ${icon ? `<span class="material-icons">${icon}</span>` : ''}
              <span class="btn-label">${label}</span>
              ${badgeHtml}
            </button>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    // Attach collapsible section toggle handlers
    container.querySelectorAll('.section-title-toggle').forEach(title => {
      title.addEventListener('click', () => {
        const sec = title.closest('.control-section');
        const grid = sec.querySelector('.control-grid');
        const icon = title.querySelector('.section-toggle-icon');
        sec.classList.toggle('collapsed');
        grid.classList.toggle('section-content-collapsed');
        if (icon) icon.textContent = sec.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
      });
    });

    // Attach click / long-press handlers
    container.querySelectorAll('[data-macro-btn]').forEach(btn => {
      const sectionName = btn.dataset.section;
      const idx = parseInt(btn.dataset.macroBtnIdx || btn.dataset.macroBtn);
      const section = sections.find(s => s.section === sectionName);
      if (!section) return;
      const item = section.items[idx];
      if (!item) return;

      if (item.long_press) {
        this._attachLongPress(btn, item);
      } else {
        btn.addEventListener('click', async () => {
          await this._handleButtonClick(btn, item);
        });
      }
    });
  },

  // Long press: hold 800ms for alternate action, short tap for normal action
  _attachLongPress(btn, item) {
    let pressTimer = null;
    let longPressed = false;

    const startPress = () => {
      longPressed = false;
      pressTimer = setTimeout(async () => {
        longPressed = true;
        btn.classList.add('long-press-fire');
        setTimeout(() => btn.classList.remove('long-press-fire'), 200);
        const lpAction = item.long_press.action;
        if (lpAction?.type === 'navigate') {
          Router.navigate(lpAction.page);
        } else if (lpAction) {
          await this._handleButtonClick(btn, { ...item, action: lpAction, toggle: null, long_press: null });
        }
      }, this._longPressDelay);
    };

    const endPress = async () => {
      clearTimeout(pressTimer);
      if (!longPressed) {
        await this._handleButtonClick(btn, item);
      }
    };

    const cancelPress = () => {
      clearTimeout(pressTimer);
    };

    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('mouseup', endPress);
    btn.addEventListener('mouseleave', cancelPress);
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); startPress(); }, { passive: false });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); endPress(); });
    btn.addEventListener('touchcancel', cancelPress);
  },

  async _handleButtonClick(btn, item) {
    let action = item.action;
    let confirmMsg = '';
    let useStepConfirm = false;
    let displayLabel = item.label || '';

    // Toggle: resolve current action based on live state
    if (item.toggle) {
      const isOn = this.resolveState(item.toggle.state);
      const resolved = isOn ? item.toggle.on : item.toggle.off;
      action = resolved.action;
      confirmMsg = resolved.confirm || '';
      useStepConfirm = resolved.confirm_steps === true;
      displayLabel = resolved.label || item.label || '';
    } else {
      confirmMsg = btn.dataset.confirm || '';
      useStepConfirm = btn.dataset.confirmSteps === 'true';
    }

    if (!action) return;

    // Step confirmation: show expanded step list with checkboxes
    if (useStepConfirm && action.type === 'macro') {
      const result = await this.showStepConfirm(action.macro, confirmMsg);
      if (!result.confirmed) return;

      btn.classList.add('loading');
      btn.disabled = true;
      try {
        const execResult = await this.execute(action.macro, result.skipSteps);
        if (execResult && execResult.success) {
          App.showToast(`${displayLabel || action.macro}: Done`, 2000);
        } else if (execResult && execResult.error) {
          App.showToast(`${displayLabel}: ${execResult.error}`, 4000, 'error');
        }
      } finally {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
      return;
    }

    // Simple confirmation check
    if (confirmMsg) {
      if (!await App.showConfirm(confirmMsg)) return;
    }

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      if (action.type === 'macro') {
        const result = await this.execute(action.macro);
        if (result && result.success) {
          App.showToast(`${displayLabel || action.macro}: Done`, 2000);
        } else if (result && result.error) {
          App.showToast(`${displayLabel}: ${result.error}`, 4000, 'error');
        }

      } else if (action.type === 'moip_switch') {
        await MoIPAPI.switchSource(String(action.tx), String(action.rx));
        App.showToast(displayLabel || 'Source switched');

      } else if (action.type === 'ha_service') {
        await fetch(`/api/ha/service/${action.domain}/${action.service}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': this.tabletId },
          body: JSON.stringify(action.data || {}),
        });
        App.showToast(displayLabel || 'HA service called');

      } else if (action.type === 'thermostat') {
        btn.classList.remove('loading');
        btn.disabled = false;
        this._openThermostatPanel(action.entity);
        return;

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
      if (!item) return;

      // --- Toggle button: swap label, icon, and state class ---
      if (item.toggle) {
        const isOn = this.resolveState(item.toggle.state);
        const resolved = isOn ? item.toggle.on : item.toggle.off;
        const onStyle = item.toggle.state?.on_style || 'active';

        // Update icon
        const iconEl = btn.querySelector('.material-icons');
        if (iconEl) iconEl.textContent = resolved.icon || item.icon || '';

        // Update label
        const labelEl = btn.querySelector('.btn-label');
        if (labelEl) labelEl.textContent = resolved.label || item.label || '';

        // Clear previous state classes, apply current
        btn.classList.remove('active', 'active-danger', 'live', 'recording');
        // Clear dynamic btn-* style classes (but keep btn and structural classes)
        [...btn.classList].forEach(c => {
          if (c.startsWith('btn-') && c !== 'btn-badge' && c !== 'btn-disabled-state' && c !== 'btn-label') {
            btn.classList.remove(c);
          }
        });
        // Apply resolved style (e.g., "large" → "btn-large")
        const resolvedStyle = resolved.style || '';
        if (resolvedStyle) {
          resolvedStyle.split(' ').filter(Boolean).forEach(s => btn.classList.add(`btn-${s}`));
        }
        if (isOn) {
          btn.classList.add(onStyle);
        }

      } else if (item.state) {
        // --- Regular state binding (existing behavior) ---
        const stateActive = this.resolveState(item.state);
        const onStyle = item.state.on_style || 'active';
        if (stateActive === true) {
          btn.classList.add(onStyle);
        } else {
          btn.classList.remove(onStyle);
        }
      }

      // --- Badge update ---
      if (item.badge) {
        let badgeEl = btn.querySelector('.btn-badge');
        if (!badgeEl) {
          badgeEl = document.createElement('span');
          badgeEl.className = 'btn-badge';
          btn.appendChild(badgeEl);
        }
        const val = this.resolveValue(item.badge);
        badgeEl.textContent = this._formatBadge(val, item.badge.format);
      }

      // --- disabled_when update ---
      const sectionDW = section.disabled_when;
      const shouldDisable = this._checkDisabledWhen(sectionDW) || this._checkDisabledWhen(item.disabled_when);
      if (!btn.classList.contains('loading')) {
        btn.disabled = shouldDisable;
        btn.classList.toggle('btn-disabled-state', shouldDisable);
      }
    });
  },

  // -----------------------------------------------------------------------
  // Thermostat Panel — Nest-style circular dial
  // -----------------------------------------------------------------------

  async _openThermostatPanel(entityId) {
    if (!entityId) return;

    // Fetch current state from HA
    let state = null;
    try {
      const resp = await fetch(`/api/ha/states/${entityId}`, {
        headers: { 'X-Tablet-ID': this.tabletId },
      });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('Thermostat state fetch failed:', resp.status, errText);
        App.showToast(`Failed to load thermostat (${resp.status})`, 'error');
        return;
      }
      state = await resp.json();
      console.log('Thermostat state:', JSON.stringify(state).substring(0, 500));
    } catch (e) {
      console.error('Thermostat fetch error:', e);
      App.showToast('Failed to load thermostat state', 'error');
      return;
    }

    if (state.error) {
      App.showToast(`Thermostat error: ${state.error}`, 'error');
      return;
    }

    const attrs = state.attributes || {};
    const friendlyName = attrs.friendly_name || entityId;
    const currentTemp = attrs.current_temperature != null ? Math.round(attrs.current_temperature) : '--';
    const targetTemp = attrs.temperature != null ? Math.round(attrs.temperature) : 72;
    const hvacMode = state.state || 'off';  // heat, cool, heat_cool, off, fan_only
    const hvacModes = attrs.hvac_modes || ['off', 'heat', 'cool'];
    const minTemp = attrs.min_temp || 50;
    const maxTemp = attrs.max_temp || 90;
    const hvacAction = attrs.hvac_action || '';  // heating, cooling, idle, off

    const self = this;
    let _target = targetTemp;
    let _mode = hvacMode;
    let _pollTimer = null;

    App.showPanel(friendlyName, (body) => {
      body.style.padding = '24px';
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.alignItems = 'center';

      body.innerHTML = self._thermostatHTML(_target, currentTemp, _mode, hvacAction, minTemp, maxTemp, hvacModes);
      self._wireThermostatEvents(body, entityId, {
        get target() { return _target; },
        set target(v) { _target = v; },
        get mode() { return _mode; },
        set mode(v) { _mode = v; },
        minTemp, maxTemp
      });

      // Poll for live updates
      _pollTimer = setInterval(async () => {
        try {
          const r = await fetch(`/api/ha/states/${entityId}`, {
            headers: { 'X-Tablet-ID': self.tabletId },
          });
          const s = await r.json();
          const a = s.attributes || {};
          const curEl = body.querySelector('#thermo-current');
          const actionEl = body.querySelector('#thermo-action');
          if (curEl && a.current_temperature != null) {
            curEl.textContent = Math.round(a.current_temperature) + '\u00B0';
          }
          if (actionEl) {
            actionEl.textContent = self._hvacActionLabel(a.hvac_action || '');
          }
        } catch (e) { /* silent */ }
      }, 5000);
    });

    // Clean up on panel close
    const observer = new MutationObserver(() => {
      if (!document.getElementById('panel-overlay')) {
        if (_pollTimer) clearInterval(_pollTimer);
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
  },

  _thermostatHTML(target, current, mode, action, minTemp, maxTemp, modes) {
    const CX = 140, CY = 140, R = 120;
    const START_ANGLE = 135, END_ANGLE = 405; // 270° arc
    const RANGE = END_ANGLE - START_ANGLE;

    const frac = (target - minTemp) / (maxTemp - minTemp);
    const angle = START_ANGLE + frac * RANGE;

    // Arc path helper
    const arcPath = (startDeg, endDeg, r) => {
      const s = (startDeg - 90) * Math.PI / 180;
      const e = (endDeg - 90) * Math.PI / 180;
      const x1 = CX + r * Math.cos(s), y1 = CY + r * Math.sin(s);
      const x2 = CX + r * Math.cos(e), y2 = CY + r * Math.sin(e);
      const largeArc = (endDeg - startDeg) > 180 ? 1 : 0;
      return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
    };

    // Indicator dot position
    const dotAngle = (angle - 90) * Math.PI / 180;
    const dotX = CX + R * Math.cos(dotAngle);
    const dotY = CY + R * Math.sin(dotAngle);

    // Color based on mode
    const modeColor = mode === 'heat' ? '#ff6b35' : mode === 'cool' ? '#4dabf7' : '#888';
    const activeColor = mode === 'heat' ? '#ff6b35' : mode === 'cool' ? '#4dabf7' : 'var(--accent)';

    // Mode buttons
    const modeIcons = { off: 'power_settings_new', heat: 'local_fire_department', cool: 'ac_unit', heat_cool: 'thermostat_auto', fan_only: 'air' };
    const modeLabels = { off: 'Off', heat: 'Heat', cool: 'Cool', heat_cool: 'Auto', fan_only: 'Fan' };
    const modeButtons = modes.map(m =>
      `<button class="thermo-mode-btn${m === mode ? ' active' : ''}" data-mode="${m}" style="${m === mode ? `background:${modeIcons[m] ? activeColor : 'var(--accent)'};color:#fff;` : ''}">
        <span class="material-icons" style="font-size:20px;">${modeIcons[m] || 'thermostat'}</span>
        <span>${modeLabels[m] || m}</span>
      </button>`
    ).join('');

    return `
      <div class="thermo-dial-wrap">
        <svg width="280" height="280" viewBox="0 0 280 280" id="thermo-svg">
          <!-- Background arc (track) -->
          <path d="${arcPath(START_ANGLE, END_ANGLE, R)}" fill="none" stroke="var(--border)" stroke-width="12" stroke-linecap="round"/>
          <!-- Active arc (filled to target) -->
          <path d="${arcPath(START_ANGLE, Math.min(angle, END_ANGLE), R)}" fill="none" stroke="${modeColor}" stroke-width="12" stroke-linecap="round" id="thermo-arc"/>
          <!-- Tick marks -->
          ${this._thermoTicks(CX, CY, R, minTemp, maxTemp, START_ANGLE, RANGE)}
          <!-- Draggable indicator dot -->
          <circle cx="${dotX}" cy="${dotY}" r="16" fill="${modeColor}" stroke="#fff" stroke-width="3" id="thermo-dot" style="cursor:grab;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));"/>
          <!-- Center text -->
          <text x="${CX}" y="${CY - 24}" text-anchor="middle" fill="var(--text-secondary)" font-size="13" id="thermo-action">${this._hvacActionLabel(action)}</text>
          <text x="${CX}" y="${CY + 8}" text-anchor="middle" fill="var(--text)" font-size="48" font-weight="700" id="thermo-target">${target}\u00B0</text>
          <text x="${CX}" y="${CY + 30}" text-anchor="middle" fill="var(--text-secondary)" font-size="13">TARGET</text>
          <text x="${CX}" y="${CY + 56}" text-anchor="middle" fill="var(--text-secondary)" font-size="16" id="thermo-current">
            ${current}\u00B0
          </text>
          <text x="${CX}" y="${CY + 72}" text-anchor="middle" fill="var(--text-secondary)" font-size="11">CURRENT</text>
        </svg>
        <!-- +/- buttons flanking the dial -->
        <button class="thermo-adj-btn thermo-adj-minus" id="thermo-minus">
          <span class="material-icons">remove</span>
        </button>
        <button class="thermo-adj-btn thermo-adj-plus" id="thermo-plus">
          <span class="material-icons">add</span>
        </button>
      </div>

      <div class="thermo-mode-bar">
        ${modeButtons}
      </div>
    `;
  },

  _thermoTicks(cx, cy, r, minT, maxT, startAngle, range) {
    let ticks = '';
    const outerR = r + 18, innerR = r + 10;
    for (let t = minT; t <= maxT; t += 5) {
      const frac = (t - minT) / (maxT - minT);
      const deg = startAngle + frac * range;
      const rad = (deg - 90) * Math.PI / 180;
      const x1 = cx + innerR * Math.cos(rad), y1 = cy + innerR * Math.sin(rad);
      const x2 = cx + outerR * Math.cos(rad), y2 = cy + outerR * Math.sin(rad);
      const isMajor = t % 10 === 0;
      ticks += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="var(--text-secondary)" stroke-width="${isMajor ? 2 : 1}" opacity="${isMajor ? 0.6 : 0.25}"/>`;
      if (isMajor) {
        const lx = cx + (outerR + 12) * Math.cos(rad), ly = cy + (outerR + 12) * Math.sin(rad);
        ticks += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="central" fill="var(--text-secondary)" font-size="10" opacity="0.5">${t}</text>`;
      }
    }
    return ticks;
  },

  _hvacActionLabel(action) {
    switch (action) {
      case 'heating': return 'HEATING';
      case 'cooling': return 'COOLING';
      case 'idle': return 'IDLE';
      case 'drying': return 'DRYING';
      case 'fan': return 'FAN';
      default: return '';
    }
  },

  _wireThermostatEvents(body, entityId, state) {
    const svg = body.querySelector('#thermo-svg');
    const dot = body.querySelector('#thermo-dot');
    const arc = body.querySelector('#thermo-arc');
    const targetText = body.querySelector('#thermo-target');
    const CX = 140, CY = 140, R = 120;
    const START_ANGLE = 135, END_ANGLE = 405, RANGE = END_ANGLE - START_ANGLE;

    let sendTimer = null;
    const self = this;

    const modeColor = () => state.mode === 'heat' ? '#ff6b35' : state.mode === 'cool' ? '#4dabf7' : '#888';

    const updateVisual = () => {
      const frac = (state.target - state.minTemp) / (state.maxTemp - state.minTemp);
      const angle = START_ANGLE + Math.max(0, Math.min(1, frac)) * RANGE;
      const rad = (angle - 90) * Math.PI / 180;
      const dx = CX + R * Math.cos(rad), dy = CY + R * Math.sin(rad);
      if (dot) { dot.setAttribute('cx', dx); dot.setAttribute('cy', dy); dot.setAttribute('fill', modeColor()); }
      if (targetText) targetText.textContent = state.target + '\u00B0';

      // Redraw active arc
      if (arc) {
        const s = (START_ANGLE - 90) * Math.PI / 180;
        const e = (angle - 90) * Math.PI / 180;
        const x1 = CX + R * Math.cos(s), y1 = CY + R * Math.sin(s);
        const x2 = CX + R * Math.cos(e), y2 = CY + R * Math.sin(e);
        const largeArc = (angle - START_ANGLE) > 180 ? 1 : 0;
        arc.setAttribute('d', `M ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2}`);
        arc.setAttribute('stroke', modeColor());
      }
    };

    const scheduleSet = () => {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(async () => {
        const payload = { entity_id: entityId, temperature: state.target };
        console.log('Setting temperature:', payload);
        try {
          const r = await fetch(`/api/ha/service/climate/set_temperature`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': self.tabletId },
            body: JSON.stringify(payload),
          });
          console.log('set_temperature response:', r.status, await r.text());
        } catch (e) { console.error('set_temperature error:', e); }
      }, 600);
    };

    // +/- buttons
    body.querySelector('#thermo-minus')?.addEventListener('click', () => {
      if (state.target > state.minTemp) { state.target--; updateVisual(); scheduleSet(); }
    });
    body.querySelector('#thermo-plus')?.addEventListener('click', () => {
      if (state.target < state.maxTemp) { state.target++; updateVisual(); scheduleSet(); }
    });

    // Drag on SVG
    if (svg) {
      let dragging = false;

      const angleFromPoint = (clientX, clientY) => {
        const rect = svg.getBoundingClientRect();
        const scaleX = 280 / rect.width, scaleY = 280 / rect.height;
        const x = (clientX - rect.left) * scaleX - CX;
        const y = (clientY - rect.top) * scaleY - CY;
        let deg = Math.atan2(y, x) * 180 / Math.PI + 90;
        if (deg < 0) deg += 360;
        if (deg < START_ANGLE - 10) deg += 360; // wrap for the gap
        return deg;
      };

      const setFromAngle = (deg) => {
        const clamped = Math.max(START_ANGLE, Math.min(END_ANGLE, deg));
        const frac = (clamped - START_ANGLE) / RANGE;
        state.target = Math.round(state.minTemp + frac * (state.maxTemp - state.minTemp));
        updateVisual();
      };

      const onStart = (e) => {
        const t = e.target;
        if (t === dot || t.closest?.('#thermo-dot')) { dragging = true; e.preventDefault(); }
      };
      const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const pt = e.touches ? e.touches[0] : e;
        setFromAngle(angleFromPoint(pt.clientX, pt.clientY));
      };
      const onEnd = () => {
        if (dragging) { dragging = false; scheduleSet(); }
      };

      svg.addEventListener('mousedown', onStart);
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      svg.addEventListener('touchstart', onStart, { passive: false });
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);

      // Tap on arc area to set directly
      svg.addEventListener('click', (e) => {
        if (dragging) return;
        const rect = svg.getBoundingClientRect();
        const scaleX = 280 / rect.width, scaleY = 280 / rect.height;
        const x = (e.clientX - rect.left) * scaleX - CX;
        const y = (e.clientY - rect.top) * scaleY - CY;
        const dist = Math.sqrt(x * x + y * y);
        if (dist > R - 25 && dist < R + 30) {
          setFromAngle(angleFromPoint(e.clientX, e.clientY));
          scheduleSet();
        }
      });
    }

    // Mode buttons
    body.querySelectorAll('.thermo-mode-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newMode = btn.dataset.mode;
        state.mode = newMode;

        // Update button styles
        body.querySelectorAll('.thermo-mode-btn').forEach(b => {
          b.classList.remove('active');
          b.style.background = '';
          b.style.color = '';
        });
        btn.classList.add('active');
        btn.style.background = modeColor();
        btn.style.color = '#fff';

        // Update arc/dot color
        updateVisual();

        const modePayload = { entity_id: entityId, hvac_mode: newMode };
        console.log('Setting HVAC mode:', modePayload);
        try {
          const r = await fetch(`/api/ha/service/climate/set_hvac_mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': self.tabletId },
            body: JSON.stringify(modePayload),
          });
          console.log('set_hvac_mode response:', r.status, await r.text());
        } catch (e) { console.error('set_hvac_mode error:', e); }

        App.showToast(`Mode: ${newMode.charAt(0).toUpperCase() + newMode.slice(1)}`);
      });
    });
  },

};
