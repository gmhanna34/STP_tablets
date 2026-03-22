// Macro Builder Page — visual macro editor for creating/editing macros.yaml entries
const MacroBuilderPage = {
  _options: null,        // dropdown options from /api/macro/builder/options
  _macroList: null,      // all macro keys/labels
  _editingKey: null,     // macro key currently being edited (null = new)
  _steps: [],            // current step list being edited
  _dirty: false,

  // All known step types and their human-readable labels
  STEP_TYPES: [
    { value: 'ha_service',    label: 'HA Service Call' },
    { value: 'ha_check',      label: 'HA State Check' },
    { value: 'wattbox_power', label: 'WattBox Power' },
    { value: 'wattbox_check', label: 'WattBox Check' },
    { value: 'wattbox_reboot',label: 'WattBox Reboot' },
    { value: 'moip_switch',   label: 'MoIP Switch' },
    { value: 'moip_ir',       label: 'MoIP IR Code' },
    { value: 'epson_power',   label: 'Projector Power' },
    { value: 'epson_all',     label: 'All Projectors' },
    { value: 'x32_scene',     label: 'X32 Scene' },
    { value: 'x32_mute',      label: 'X32 Mute' },
    { value: 'x32_aux_mute',  label: 'X32 Aux Mute' },
    { value: 'obs_emit',      label: 'OBS Action' },
    { value: 'ptz_preset',    label: 'PTZ Preset' },
    { value: 'tts_announce',  label: 'TTS Announce' },
    { value: 'delay',         label: 'Delay' },
    { value: 'macro',         label: 'Call Macro' },
    { value: 'parallel',      label: 'Parallel Steps' },
    { value: 'condition',     label: 'Condition' },
    { value: 'notify',        label: 'Notify' },
    { value: 'wait_until',    label: 'Wait Until' },
    { value: 'verify_pending',label: 'Verify Pending' },
    { value: 'door_timed_unlock', label: 'Door Timed Unlock' },
  ],

  render(container) {
    container.innerHTML = `
      <div class="macrobuilder-page">
        <div class="macrobuilder-header">
          <div class="macrobuilder-header-left">
            <button class="btn-action" id="mb-back-btn" title="Back to Settings">
              <span class="material-icons">arrow_back</span>
            </button>
            <h1 class="macrobuilder-title">Macro Builder</h1>
          </div>
          <div class="macrobuilder-header-right">
            <button class="btn btn-sm" id="mb-new-btn">
              <span class="material-icons">add</span>
              <span class="btn-label">New Macro</span>
            </button>
          </div>
        </div>

        <div class="macrobuilder-layout">
          <!-- Left: macro list -->
          <div class="macrobuilder-sidebar control-section">
            <div class="section-title">Macros</div>
            <input type="text" id="mb-search" placeholder="Search macros..." class="mb-search-input">
            <div id="mb-macro-list" class="mb-macro-list">Loading...</div>
          </div>

          <!-- Right: editor -->
          <div class="macrobuilder-editor control-section">
            <div id="mb-editor-placeholder" class="mb-placeholder">
              <span class="material-icons" style="font-size:48px;opacity:0.3;">construction</span>
              <p>Select a macro to edit or create a new one</p>
            </div>
            <div id="mb-editor-form" class="mb-editor-form hidden">
              <div class="mb-editor-top">
                <div class="mb-field-row">
                  <div class="mb-field">
                    <label>Key</label>
                    <input type="text" id="mb-key" placeholder="my_macro_name" class="mb-input">
                  </div>
                  <div class="mb-field">
                    <label>Label</label>
                    <input type="text" id="mb-label" placeholder="My Macro" class="mb-input">
                  </div>
                  <div class="mb-field">
                    <label>Icon</label>
                    <input type="text" id="mb-icon" placeholder="power_settings_new" class="mb-input mb-input-sm">
                  </div>
                </div>
                <div class="mb-field">
                  <label>Description</label>
                  <input type="text" id="mb-description" placeholder="What this macro does" class="mb-input mb-input-wide">
                </div>
              </div>

              <div class="mb-steps-header">
                <div class="section-title">Steps</div>
                <button class="btn btn-sm" id="mb-add-step-btn">
                  <span class="material-icons">add</span>
                  <span class="btn-label">Add Step</span>
                </button>
              </div>

              <div id="mb-steps-list" class="mb-steps-list"></div>

              <div class="mb-editor-actions">
                <button class="btn btn-success" id="mb-save-btn">
                  <span class="material-icons">save</span>
                  <span class="btn-label">Save Macro</span>
                </button>
                <button class="btn btn-danger" id="mb-delete-btn" style="display:none;">
                  <span class="material-icons">delete</span>
                  <span class="btn-label">Delete</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  async init() {
    this._bindEvents();
    await this._loadOptions();
    await this._loadMacroList();
  },

  destroy() {
    this._options = null;
    this._macroList = null;
    this._editingKey = null;
    this._steps = [];
    this._dirty = false;
  },

  // --- Event Binding ---

  _bindEvents() {
    document.getElementById('mb-back-btn').addEventListener('click', () => {
      Router.navigate('settings');
    });

    document.getElementById('mb-new-btn').addEventListener('click', () => {
      this._newMacro();
    });

    document.getElementById('mb-search').addEventListener('input', (e) => {
      this._filterList(e.target.value);
    });

    document.getElementById('mb-add-step-btn').addEventListener('click', () => {
      this._addStep();
    });

    document.getElementById('mb-save-btn').addEventListener('click', () => {
      this._saveMacro();
    });

    document.getElementById('mb-delete-btn').addEventListener('click', () => {
      this._deleteMacro();
    });

    // Drag-and-drop for step reordering
    const stepsList = document.getElementById('mb-steps-list');
    stepsList.addEventListener('dragover', (e) => {
      e.preventDefault();
      const dragging = stepsList.querySelector('.mb-step.dragging');
      if (!dragging) return;
      const afterEl = this._getDragAfterElement(stepsList, e.clientY);
      if (afterEl) {
        stepsList.insertBefore(dragging, afterEl);
      } else {
        stepsList.appendChild(dragging);
      }
    });

    stepsList.addEventListener('dragend', () => {
      // Sync _steps array to match new DOM order
      const cards = stepsList.querySelectorAll('.mb-step');
      const newSteps = [];
      cards.forEach(card => {
        const idx = parseInt(card.dataset.stepIndex, 10);
        if (this._steps[idx]) newSteps.push(this._steps[idx]);
      });
      if (newSteps.length === this._steps.length) {
        this._steps = newSteps;
        this._renderSteps(); // re-render with correct indices
      }
    });
  },

  // --- Data Loading ---

  async _loadOptions() {
    try {
      const resp = await fetch('/api/macro/builder/options', { signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._options = await resp.json();
    } catch (e) {
      console.error('Failed to load macro builder options:', e);
      this._options = {};
      App.showToast('Failed to load macro options', 3000, 'error');
    }
  },

  async _loadMacroList() {
    try {
      const resp = await fetch('/api/macros', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this._macroList = [];
      const macros = data.macros || {};
      for (const [key, def] of Object.entries(macros)) {
        this._macroList.push({
          key,
          label: def.label || key,
          icon: def.icon || 'play_arrow',
          steps: typeof def.steps === 'number' ? def.steps : (def.steps || []).length,
        });
      }
      this._macroList.sort((a, b) => a.label.localeCompare(b.label));
      this._renderMacroList();
    } catch (e) {
      console.error('Failed to load macro list:', e);
      const listEl = document.getElementById('mb-macro-list');
      if (listEl) listEl.innerHTML = '<div class="mb-placeholder-sm">Failed to load macros</div>';
    }
  },

  // --- Macro List ---

  _renderMacroList(filter = '') {
    const listEl = document.getElementById('mb-macro-list');
    if (!listEl || !this._macroList) return;

    const lcFilter = filter.toLowerCase();
    const filtered = lcFilter
      ? this._macroList.filter(m => m.label.toLowerCase().includes(lcFilter) || m.key.toLowerCase().includes(lcFilter))
      : this._macroList;

    if (filtered.length === 0) {
      listEl.innerHTML = '<div class="mb-placeholder-sm">No macros found</div>';
      return;
    }

    listEl.innerHTML = filtered.map(m => `
      <button class="mb-macro-item ${m.key === this._editingKey ? 'active' : ''}" data-key="${m.key}">
        <span class="material-icons">${m.icon}</span>
        <div class="mb-macro-item-text">
          <span class="mb-macro-item-label">${m.label}</span>
          <span class="mb-macro-item-key">${m.key} (${m.steps} steps)</span>
        </div>
      </button>
    `).join('');

    listEl.querySelectorAll('.mb-macro-item').forEach(btn => {
      btn.addEventListener('click', () => this._editMacro(btn.dataset.key));
    });
  },

  _filterList(text) {
    this._renderMacroList(text);
  },

  // --- Editor ---

  _newMacro() {
    this._editingKey = null;
    this._steps = [];
    this._dirty = false;

    document.getElementById('mb-editor-placeholder').classList.add('hidden');
    document.getElementById('mb-editor-form').classList.remove('hidden');
    document.getElementById('mb-key').value = '';
    document.getElementById('mb-key').readOnly = false;
    document.getElementById('mb-label').value = '';
    document.getElementById('mb-icon').value = '';
    document.getElementById('mb-description').value = '';
    document.getElementById('mb-delete-btn').style.display = 'none';
    this._renderSteps();
    this._renderMacroList(); // clear active highlight
  },

  async _editMacro(key) {
    if (this._dirty) {
      const ok = await App.showConfirm('Discard unsaved changes?');
      if (!ok) return;
    }

    try {
      const resp = await fetch(`/api/macro/builder/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      const def = data.definition;

      this._editingKey = key;
      this._steps = JSON.parse(JSON.stringify(def.steps || []));
      this._dirty = false;

      document.getElementById('mb-editor-placeholder').classList.add('hidden');
      document.getElementById('mb-editor-form').classList.remove('hidden');
      document.getElementById('mb-key').value = key;
      document.getElementById('mb-key').readOnly = true;
      document.getElementById('mb-label').value = def.label || '';
      document.getElementById('mb-icon').value = def.icon || '';
      document.getElementById('mb-description').value = def.description || '';
      document.getElementById('mb-delete-btn').style.display = '';
      this._renderSteps();
      this._renderMacroList();
    } catch (e) {
      App.showToast(`Failed to load macro: ${e.message}`, 3000, 'error');
    }
  },

  // --- Steps Rendering ---

  _renderSteps() {
    const container = document.getElementById('mb-steps-list');
    if (!container) return;

    if (this._steps.length === 0) {
      container.innerHTML = '<div class="mb-placeholder-sm">No steps yet. Click "Add Step" to begin.</div>';
      return;
    }

    container.innerHTML = this._steps.map((step, i) => this._renderStepCard(step, i)).join('');
    this._bindStepEvents(container);
  },

  _renderStepCard(step, index) {
    const type = step.type || '';
    const typeLabel = (this.STEP_TYPES.find(t => t.value === type) || {}).label || type || 'Select type...';
    const message = step.message || '';
    const onFail = step.on_fail || 'abort';

    return `
      <div class="mb-step" data-step-index="${index}" draggable="true">
        <div class="mb-step-header">
          <span class="material-icons mb-step-drag" title="Drag to reorder">drag_indicator</span>
          <span class="mb-step-number">${index + 1}</span>
          <span class="mb-step-type-label">${typeLabel}</span>
          <span class="mb-step-msg-preview">${message ? '— ' + message : ''}</span>
          <div class="mb-step-actions">
            <button class="mb-step-btn" data-action="duplicate" data-index="${index}" title="Duplicate">
              <span class="material-icons">content_copy</span>
            </button>
            <button class="mb-step-btn" data-action="remove" data-index="${index}" title="Remove">
              <span class="material-icons">close</span>
            </button>
            <button class="mb-step-btn mb-step-toggle" data-action="toggle" data-index="${index}" title="Expand/Collapse">
              <span class="material-icons">expand_more</span>
            </button>
          </div>
        </div>
        <div class="mb-step-body hidden" id="mb-step-body-${index}">
          <div class="mb-field-row">
            <div class="mb-field">
              <label>Type</label>
              <select class="mb-input mb-step-type-select" data-index="${index}">
                <option value="">-- Select --</option>
                ${this.STEP_TYPES.map(t => `<option value="${t.value}" ${t.value === type ? 'selected' : ''}>${t.label}</option>`).join('')}
              </select>
            </div>
            <div class="mb-field">
              <label>On Fail</label>
              <select class="mb-input mb-step-onfail-select" data-index="${index}">
                <option value="abort" ${onFail === 'abort' ? 'selected' : ''}>Abort</option>
                <option value="skip" ${onFail === 'skip' ? 'selected' : ''}>Skip</option>
                <option value="retry:1" ${onFail === 'retry:1' ? 'selected' : ''}>Retry x1</option>
                <option value="retry:2" ${onFail === 'retry:2' ? 'selected' : ''}>Retry x2</option>
                <option value="retry:3" ${onFail === 'retry:3' ? 'selected' : ''}>Retry x3</option>
              </select>
            </div>
          </div>
          <div class="mb-field">
            <label>Message</label>
            <input type="text" class="mb-input mb-input-wide mb-step-message" data-index="${index}"
                   value="${this._escAttr(message)}" placeholder="Step description shown during execution">
          </div>
          ${this._renderStepFields(step, index)}
        </div>
      </div>
    `;
  },

  _renderStepFields(step, index) {
    const type = step.type || '';
    const opts = this._options || {};

    switch (type) {
      case 'ha_service':
        return this._fieldGroup(index, [
          this._selectField(index, 'entity_id', 'Entity', (opts.ha_entities || []).map(e => ({ value: e.id, label: e.id })), step.entity_id),
          this._textField(index, 'domain', 'Domain', step.domain || '', 'switch'),
          this._textField(index, 'service', 'Service', step.service || '', 'turn_on'),
          this._checkboxField(index, 'verify', 'Verify', !!step.verify),
        ]);

      case 'ha_check':
        return this._fieldGroup(index, [
          this._selectField(index, 'entity_id', 'Entity', (opts.ha_entities || []).map(e => ({ value: e.id, label: e.id })), step.entity_id),
          this._textField(index, 'state', 'Expected State', step.state || '', 'on'),
        ]);

      case 'wattbox_power':
        return this._fieldGroup(index, [
          this._selectField(index, 'device', 'Outlet', (opts.wattbox_outlets || []).map(o => ({ value: o.id, label: o.label })), step.device),
          this._selectField(index, 'action', 'Action', [
            { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }, { value: 'cycle', label: 'Cycle' },
          ], step.action || 'on'),
          this._checkboxField(index, 'verify', 'Verify', !!step.verify),
        ]);

      case 'wattbox_check':
        return this._fieldGroup(index, [
          this._selectField(index, 'device', 'Outlet', (opts.wattbox_outlets || []).map(o => ({ value: o.id, label: o.label })), step.device),
          this._selectField(index, 'state', 'Expected State', [
            { value: 'on', label: 'On' }, { value: 'off', label: 'Off' },
          ], step.state || 'on'),
        ]);

      case 'wattbox_reboot':
        return this._fieldGroup(index, [
          this._selectField(index, 'pdu', 'PDU', (opts.wattbox_pdus || []).map(p => ({ value: p.id, label: p.label })), step.pdu),
        ]);

      case 'moip_switch':
        return this._fieldGroup(index, [
          this._selectField(index, 'tx', 'Transmitter', (opts.moip_tx || []).map(t => ({ value: String(t.id), label: t.name })), String(step.tx || '')),
          this._selectField(index, 'rx', 'Receiver', (opts.moip_rx || []).map(r => ({ value: String(r.id), label: `${r.name}${r.location ? ' (' + r.location + ')' : ''}` })), String(step.rx || '')),
        ]);

      case 'moip_ir':
        return this._fieldGroup(index, [
          this._selectField(index, 'rx', 'Receiver', (opts.moip_rx || []).map(r => ({ value: String(r.id), label: r.name })), String(step.rx || '')),
          this._selectField(index, 'code', 'IR Code', (opts.ir_codes || []).map(c => ({ value: c, label: c })), step.code || ''),
        ]);

      case 'epson_power':
        return this._fieldGroup(index, [
          this._selectField(index, 'projector', 'Projector', (opts.projectors || []).map(p => ({ value: p.id, label: p.name })), step.projector),
          this._selectField(index, 'action', 'Action', [
            { value: 'on', label: 'On' }, { value: 'off', label: 'Off' },
          ], step.action || 'on'),
        ]);

      case 'epson_all':
        return this._fieldGroup(index, [
          this._selectField(index, 'action', 'Action', [
            { value: 'on', label: 'On' }, { value: 'off', label: 'Off' },
          ], step.action || 'on'),
        ]);

      case 'x32_scene':
        return this._fieldGroup(index, [
          this._textField(index, 'scene', 'Scene Name', step.scene || '', 'Default'),
        ]);

      case 'x32_mute':
        return this._fieldGroup(index, [
          this._textField(index, 'channel', 'Channel', step.channel || '', '1'),
          this._selectField(index, 'mute', 'Mute', [
            { value: 'true', label: 'Mute' }, { value: 'false', label: 'Unmute' },
          ], String(step.mute ?? 'true')),
        ]);

      case 'x32_aux_mute':
        return this._fieldGroup(index, [
          this._textField(index, 'bus', 'Bus', step.bus || '', '1'),
          this._selectField(index, 'mute', 'Mute', [
            { value: 'true', label: 'Mute' }, { value: 'false', label: 'Unmute' },
          ], String(step.mute ?? 'true')),
        ]);

      case 'obs_emit':
        return this._fieldGroup(index, [
          this._selectField(index, 'action', 'Action', [
            { value: 'StartStream', label: 'Start Stream' },
            { value: 'StopStream', label: 'Stop Stream' },
            { value: 'StartRecording', label: 'Start Recording' },
            { value: 'StopRecording', label: 'Stop Recording' },
            { value: 'SetCurrentScene', label: 'Set Scene' },
          ], step.action || ''),
          this._textField(index, 'scene', 'Scene (if SetCurrentScene)', step.scene || '', ''),
        ]);

      case 'ptz_preset':
        return this._fieldGroup(index, [
          this._selectField(index, 'camera', 'Camera', (opts.cameras || []).map(c => ({ value: c.id, label: c.name })), step.camera),
          this._textField(index, 'preset', 'Preset #', step.preset || '', '1'),
        ]);

      case 'tts_announce':
        return this._fieldGroup(index, [
          this._selectField(index, 'preset', 'Preset', [{ value: '', label: '(none)' }, ...(opts.tts_presets || []).map(p => ({ value: p.id, label: p.label }))], step.preset || ''),
          this._selectField(index, 'sequence', 'Sequence', [{ value: '', label: '(none)' }, ...(opts.tts_sequences || []).map(s => ({ value: s.id, label: s.label }))], step.sequence || ''),
          this._textField(index, 'text', 'Inline Text', step.text || '', ''),
          this._textField(index, 'voice', 'Voice', step.voice || '', 'en-US-AndrewNeural'),
        ]);

      case 'delay':
        return this._fieldGroup(index, [
          this._textField(index, 'seconds', 'Seconds', step.seconds || '', '1'),
        ]);

      case 'macro':
        return this._fieldGroup(index, [
          this._selectField(index, 'macro', 'Macro', (opts.macro_keys || []).map(m => ({ value: m.id, label: m.label })), step.macro),
        ]);

      case 'notify':
        return this._fieldGroup(index, [
          this._textField(index, 'message_text', 'Notification Message', step.message || '', 'Broadcast message'),
        ]);

      case 'wait_until':
        return this._fieldGroup(index, [
          this._textField(index, 'entity_id', 'Entity ID', step.entity_id || '', ''),
          this._textField(index, 'state', 'Expected State', step.state || '', 'on'),
          this._textField(index, 'timeout', 'Timeout (s)', step.timeout || '', '120'),
        ]);

      case 'verify_pending':
        return '<div class="mb-field-hint">Checks all queued verifications from prior steps with verify: true</div>';

      case 'door_timed_unlock':
        return this._fieldGroup(index, [
          this._textField(index, 'entity_id', 'Lock Entity', step.entity_id || '', 'lock.front_door'),
          this._textField(index, 'duration', 'Duration (s)', step.duration || '', '30'),
        ]);

      case 'condition':
        return `<div class="mb-field-hint">Condition steps have complex if/then/else structure.
          Edit the JSON directly below or use simpler step types.</div>
          <div class="mb-field">
            <label>Condition JSON</label>
            <textarea class="mb-input mb-input-wide mb-step-json" data-index="${index}" rows="6"
              placeholder='{"if": {"type": "ha_check", ...}, "then": [...], "else": [...]}'>${this._escHtml(JSON.stringify(this._extractCondition(step), null, 2))}</textarea>
          </div>`;

      case 'parallel':
        return `<div class="mb-field-hint">Parallel steps run sub-steps concurrently. Edit JSON below.</div>
          <div class="mb-field">
            <label>Sub-steps JSON</label>
            <textarea class="mb-input mb-input-wide mb-step-json" data-index="${index}" rows="6"
              placeholder='[{"type": "ha_service", ...}, ...]'>${this._escHtml(JSON.stringify(step.steps || [], null, 2))}</textarea>
          </div>`;

      default:
        return '';
    }
  },

  // --- Field Helpers ---

  _fieldGroup(index, fields) {
    return `<div class="mb-field-row mb-field-row-wrap">${fields.join('')}</div>`;
  },

  _textField(index, field, label, value, placeholder) {
    return `
      <div class="mb-field">
        <label>${label}</label>
        <input type="text" class="mb-input mb-step-field" data-index="${index}" data-field="${field}"
               value="${this._escAttr(String(value))}" placeholder="${this._escAttr(placeholder)}">
      </div>`;
  },

  _selectField(index, field, label, options, selected) {
    return `
      <div class="mb-field">
        <label>${label}</label>
        <select class="mb-input mb-step-field" data-index="${index}" data-field="${field}">
          <option value="">-- Select --</option>
          ${options.map(o => `<option value="${this._escAttr(o.value)}" ${o.value === selected ? 'selected' : ''}>${this._escHtml(o.label)}</option>`).join('')}
        </select>
      </div>`;
  },

  _checkboxField(index, field, label, checked) {
    return `
      <div class="mb-field mb-field-checkbox">
        <label>
          <input type="checkbox" class="mb-step-field" data-index="${index}" data-field="${field}" ${checked ? 'checked' : ''}>
          ${label}
        </label>
      </div>`;
  },

  // --- Step Event Binding ---

  _bindStepEvents(container) {
    // Toggle expand/collapse
    container.querySelectorAll('[data-action="toggle"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = btn.dataset.index;
        const body = document.getElementById(`mb-step-body-${idx}`);
        if (body) {
          body.classList.toggle('hidden');
          const icon = btn.querySelector('.material-icons');
          icon.textContent = body.classList.contains('hidden') ? 'expand_more' : 'expand_less';
        }
      });
    });

    // Remove step
    container.querySelectorAll('[data-action="remove"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        this._steps.splice(idx, 1);
        this._dirty = true;
        this._renderSteps();
      });
    });

    // Duplicate step
    container.querySelectorAll('[data-action="duplicate"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        this._steps.splice(idx + 1, 0, JSON.parse(JSON.stringify(this._steps[idx])));
        this._dirty = true;
        this._renderSteps();
      });
    });

    // Type change
    container.querySelectorAll('.mb-step-type-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        const oldType = this._steps[idx].type;
        const msg = this._steps[idx].message;
        const onFail = this._steps[idx].on_fail;
        this._steps[idx] = { type: e.target.value };
        if (msg) this._steps[idx].message = msg;
        if (onFail) this._steps[idx].on_fail = onFail;
        this._dirty = true;
        this._renderSteps();
      });
    });

    // On-fail change
    container.querySelectorAll('.mb-step-onfail-select').forEach(sel => {
      sel.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        this._steps[idx].on_fail = e.target.value;
        this._dirty = true;
      });
    });

    // Message field
    container.querySelectorAll('.mb-step-message').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        this._steps[idx].message = e.target.value;
        this._dirty = true;
      });
    });

    // Generic fields
    container.querySelectorAll('.mb-step-field').forEach(el => {
      const event = el.type === 'checkbox' ? 'change' : 'input';
      el.addEventListener(event, (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        const field = e.target.dataset.field;
        let value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;

        // Handle special notify case where field stores in message
        if (field === 'message_text') {
          this._steps[idx].message = value;
        } else {
          // Convert numeric-looking values
          if (typeof value === 'string' && /^\d+$/.test(value) && ['seconds', 'timeout', 'duration', 'preset', 'tx', 'rx', 'bus', 'channel'].includes(field)) {
            value = parseInt(value, 10);
          }
          // Convert boolean strings
          if (value === 'true') value = true;
          if (value === 'false') value = false;
          this._steps[idx][field] = value;
        }
        this._dirty = true;
      });
    });

    // JSON fields (condition, parallel)
    container.querySelectorAll('.mb-step-json').forEach(ta => {
      ta.addEventListener('input', (e) => {
        const idx = parseInt(e.target.dataset.index, 10);
        try {
          const parsed = JSON.parse(e.target.value);
          const step = this._steps[idx];
          if (step.type === 'condition') {
            Object.assign(step, parsed);
          } else if (step.type === 'parallel') {
            step.steps = parsed;
          }
          e.target.classList.remove('mb-input-error');
          this._dirty = true;
        } catch {
          e.target.classList.add('mb-input-error');
        }
      });
    });

    // Drag start
    container.querySelectorAll('.mb-step').forEach(card => {
      card.addEventListener('dragstart', () => card.classList.add('dragging'));
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
  },

  // --- Add / Save / Delete ---

  _addStep() {
    this._steps.push({ type: '', message: '' });
    this._dirty = true;
    this._renderSteps();
    // Auto-expand the new step
    const lastIdx = this._steps.length - 1;
    const body = document.getElementById(`mb-step-body-${lastIdx}`);
    if (body) {
      body.classList.remove('hidden');
      const toggle = document.querySelector(`[data-action="toggle"][data-index="${lastIdx}"] .material-icons`);
      if (toggle) toggle.textContent = 'expand_less';
    }
  },

  async _saveMacro() {
    const key = document.getElementById('mb-key').value.trim();
    const label = document.getElementById('mb-label').value.trim();
    const icon = document.getElementById('mb-icon').value.trim();
    const description = document.getElementById('mb-description').value.trim();

    if (!key) {
      App.showToast('Macro key is required', 2000, 'error');
      return;
    }
    if (this._steps.length === 0) {
      App.showToast('Add at least one step', 2000, 'error');
      return;
    }
    // Filter out empty-type steps
    const validSteps = this._steps.filter(s => s.type);
    if (validSteps.length === 0) {
      App.showToast('All steps need a type', 2000, 'error');
      return;
    }

    const definition = { label: label || key, steps: validSteps };
    if (icon) definition.icon = icon;
    if (description) definition.description = description;

    try {
      const resp = await fetch('/api/macro/builder/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, definition }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await resp.json();
      if (!resp.ok) {
        App.showToast(data.error || 'Save failed', 3000, 'error');
        return;
      }
      App.showToast(`Macro "${label || key}" saved`, 2000, 'success');
      this._editingKey = key;
      this._steps = validSteps;
      this._dirty = false;
      document.getElementById('mb-key').readOnly = true;
      document.getElementById('mb-delete-btn').style.display = '';
      await this._loadMacroList();
    } catch (e) {
      App.showToast(`Save failed: ${e.message}`, 3000, 'error');
    }
  },

  async _deleteMacro() {
    if (!this._editingKey) return;
    const ok = await App.showConfirm(`Delete macro "${this._editingKey}"? This cannot be undone.`);
    if (!ok) return;

    try {
      const resp = await fetch(`/api/macro/builder/${encodeURIComponent(this._editingKey)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      if (!resp.ok) {
        App.showToast(data.error || 'Delete failed', 3000, 'error');
        return;
      }
      App.showToast('Macro deleted', 2000);
      this._editingKey = null;
      this._steps = [];
      this._dirty = false;
      document.getElementById('mb-editor-form').classList.add('hidden');
      document.getElementById('mb-editor-placeholder').classList.remove('hidden');
      await this._loadMacroList();
    } catch (e) {
      App.showToast(`Delete failed: ${e.message}`, 3000, 'error');
    }
  },

  // --- Utilities ---

  _extractCondition(step) {
    const cond = {};
    if (step.if) cond.if = step.if;
    if (step.then) cond.then = step.then;
    if (step.else) cond.else = step.else;
    return cond;
  },

  _getDragAfterElement(container, y) {
    const els = [...container.querySelectorAll('.mb-step:not(.dragging)')];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  },

  _escAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};
