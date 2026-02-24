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
  }
};
