const SettingsPage = {
  pollTimer: null,
  _activeTab: 'admin',

  render(container) {
    const roles = Auth.getRoles();
    const currentRole = Auth.currentRole;
    const locationName = Auth.getDisplayName();
    const isOverridden = Auth.isRoleOverridden();

    container.innerHTML = `
      <div class="page-header">
        <h1>SETTINGS</h1>
      </div>

      <div class="cam-tab-bar" id="settings-tabs">
        <button class="cam-tab" data-settings-tab="power">
          <span class="material-icons">power</span>
          <span>Power</span>
        </button>
        <button class="cam-tab" data-settings-tab="audio">
          <span class="material-icons">equalizer</span>
          <span>Audio</span>
        </button>
        <button class="cam-tab" data-settings-tab="thermostats">
          <span class="material-icons">thermostat</span>
          <span>Thermostats</span>
        </button>
        <button class="cam-tab" data-settings-tab="tvs">
          <span class="material-icons">tv</span>
          <span>TV's</span>
        </button>
        <button class="cam-tab" data-settings-tab="schedule">
          <span class="material-icons">schedule</span>
          <span>Schedule</span>
        </button>
        <button class="cam-tab" data-settings-tab="logs">
          <span class="material-icons">history</span>
          <span>Logs</span>
        </button>
        <button class="cam-tab active" data-settings-tab="admin">
          <span class="material-icons">admin_panel_settings</span>
          <span>Admin</span>
        </button>
      </div>

      <!-- ============================================================ -->
      <!-- POWER TAB                                                     -->
      <!-- ============================================================ -->
      <div id="settings-tab-power" class="settings-tab-content" style="display:none;">
        <div class="page-grid">
          <div class="control-section col-span-6">
            <div class="section-title">SmartThings Switches</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Control SmartThings-connected power outlets and switches.
            </div>
            <button class="btn" id="btn-open-smartthings" style="display:inline-flex;">
              <span class="material-icons">power</span>
              <span class="btn-label">Open SmartThings Panel</span>
            </button>
          </div>
          <div class="control-section col-span-6">
            <div class="section-title">WattBox Outlets</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Control WattBox IP power distribution outlets.
            </div>
            <button class="btn" id="btn-open-wattbox" style="display:inline-flex;">
              <span class="material-icons">electrical_services</span>
              <span class="btn-label">Open WattBox Panel</span>
            </button>
          </div>
          <div class="control-section">
            <div class="section-title">EcoFlow Batteries</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              View battery levels and toggle AC / DC outputs for EcoFlow battery packs.
            </div>
            <button class="btn" id="btn-open-ecoflow" style="display:inline-flex;">
              <span class="material-icons">battery_charging_full</span>
              <span class="btn-label">Open EcoFlow Panel</span>
            </button>
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- AUDIO TAB                                                     -->
      <!-- ============================================================ -->
      <div id="settings-tab-audio" class="settings-tab-content" style="display:none;">
        <div class="page-grid">
          <div class="control-section">
            <div class="section-title">Quick Actions</div>
            <div class="control-grid" style="grid-template-columns:repeat(4, 1fr);" id="x32-quick-actions">
              <button class="btn" id="x32-mute-all"><span class="material-icons">volume_off</span><span class="btn-label">Mute All</span></button>
              <button class="btn" id="x32-unmute-all"><span class="material-icons">volume_up</span><span class="btn-label">Unmute All</span></button>
              <button class="btn" id="x32-reload-scene"><span class="material-icons">refresh</span><span class="btn-label">Reload Scene</span></button>
              <button class="btn" id="x32-mute-band"><span class="material-icons">music_off</span><span class="btn-label">Mute Music</span></button>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">Mixer Scenes</div>
            <div class="scene-grid" id="x32-scenes"></div>
          </div>
          <div class="control-section">
            <div class="section-title">Input Channels</div>
            <div id="mixer-container">
              <div class="text-center" style="opacity:0.5;">Loading mixer status...</div>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">Bus / Aux Outputs</div>
            <div id="aux-container" class="mixer-grid"></div>
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- THERMOSTATS TAB                                               -->
      <!-- ============================================================ -->
      <div id="settings-tab-thermostats" class="settings-tab-content" style="display:none;">
        <div class="page-grid" id="thermostats-grid">
          <div class="text-center" style="opacity:0.5;padding:30px;">Loading thermostats...</div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- TV'S TAB                                                      -->
      <!-- ============================================================ -->
      <div id="settings-tab-tvs" class="settings-tab-content" style="display:none;">
        <div class="page-grid">
          <div class="control-section">
            <div class="text-center" style="opacity:0.5;padding:30px;">
              <span class="material-icons" style="font-size:48px;opacity:0.3;">tv</span>
              <div style="margin-top:8px;">TV controls coming soon.</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- SCHEDULE TAB                                                  -->
      <!-- ============================================================ -->
      <div id="settings-tab-schedule" class="settings-tab-content" style="display:none;">
        <div class="page-grid">
          <div class="control-section">
            <div class="section-title">Scheduled Automations</div>
            <div id="schedule-container">
              <div class="text-center" style="opacity:0.5;font-size:13px;">Loading schedules...</div>
            </div>
            <div style="margin-top:8px;" class="text-center">
              <button class="btn" id="btn-add-schedule" style="display:inline-flex;max-width:300px;">
                <span class="material-icons">add_alarm</span>
                <span class="btn-label">Add Schedule</span>
              </button>
            </div>
            <div id="schedule-form" class="hidden" style="margin-top:12px;background:#1a1a2e;padding:12px;border-radius:8px;">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                <div>
                  <label style="font-size:11px;opacity:0.7;">Name</label>
                  <input type="text" id="sched-name" placeholder="e.g. Sunday Morning Setup"
                    style="width:100%;padding:6px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:13px;font-family:inherit;">
                </div>
                <div>
                  <label style="font-size:11px;opacity:0.7;">Macro</label>
                  <select id="sched-macro" style="width:100%;padding:6px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:13px;font-family:inherit;"></select>
                </div>
                <div>
                  <label style="font-size:11px;opacity:0.7;">Time</label>
                  <input type="time" id="sched-time" value="08:00"
                    style="width:100%;padding:6px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:13px;font-family:inherit;">
                </div>
                <div>
                  <label style="font-size:11px;opacity:0.7;">Days</label>
                  <div id="sched-days" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">
                    <label style="font-size:11px;"><input type="checkbox" value="0" checked> Mon</label>
                    <label style="font-size:11px;"><input type="checkbox" value="1" checked> Tue</label>
                    <label style="font-size:11px;"><input type="checkbox" value="2" checked> Wed</label>
                    <label style="font-size:11px;"><input type="checkbox" value="3" checked> Thu</label>
                    <label style="font-size:11px;"><input type="checkbox" value="4" checked> Fri</label>
                    <label style="font-size:11px;"><input type="checkbox" value="5" checked> Sat</label>
                    <label style="font-size:11px;"><input type="checkbox" value="6" checked> Sun</label>
                  </div>
                </div>
              </div>
              <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
                <button class="btn" id="btn-sched-cancel" style="min-height:auto;padding:6px 12px;">Cancel</button>
                <button class="btn btn-success" id="btn-sched-save" style="min-height:auto;padding:6px 12px;background:#00b050;border-color:#00b050;">Save</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- LOGS TAB                                                      -->
      <!-- ============================================================ -->
      <div id="settings-tab-logs" class="settings-tab-content" style="display:none;">
        <div class="page-grid">
          <div class="control-section">
            <div class="section-title">Audit Log</div>
            <div class="text-center" style="margin-bottom:8px;">
              <button class="btn" id="btn-load-audit" style="display:inline-flex;max-width:300px;">
                <span class="material-icons">history</span>
                <span class="btn-label">Load Recent Activity</span>
              </button>
            </div>
            <div id="audit-container" class="hidden">
              <div class="audit-controls" style="display:flex;gap:8px;margin-bottom:8px;align-items:center;">
                <select id="audit-filter" style="padding:6px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:13px;">
                  <option value="">All Actions</option>
                  <option value="scene:execute">Scenes</option>
                  <option value="moip:">MoIP</option>
                  <option value="ptz:">PTZ</option>
                  <option value="projector:">Projectors</option>
                  <option value="ha:">Home Assistant</option>
                  <option value="x32:">X32 Mixer</option>
                </select>
                <span id="audit-count" style="font-size:12px;opacity:0.6;"></span>
              </div>
              <div id="audit-log" style="max-height:300px;overflow-y:auto;font-size:12px;font-family:monospace;"></div>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">Connected Tablets</div>
            <div id="sessions-container">
              <div class="text-center" style="opacity:0.5;font-size:13px;">Load audit log to see connected tablets</div>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- ADMIN TAB                                                     -->
      <!-- ============================================================ -->
      <div id="settings-tab-admin" class="settings-tab-content">
        <div class="page-grid">
          <div class="control-section">
            <div class="section-title">Tablet Location</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              This tablet's location is determined by its URL. Change by updating the Fully Kiosk start URL.
            </div>
            <div style="padding:12px;background:#1a1a2e;border-radius:8px;font-size:16px;font-weight:bold;text-align:center;">
              <span class="material-icons" style="vertical-align:middle;margin-right:6px;">place</span>
              ${locationName}
            </div>
          </div>

          <div class="control-section">
            <div class="section-title">Permission Role</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Controls which menu items are visible. Defaults to the location's role but can be overridden.
              ${isOverridden ? '<br><span style="color:#ff9800;">Currently overridden from default.</span>' : ''}
            </div>
            <div class="control-grid" style="grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));">
              ${roles.map(role => `
                <button class="btn ${role.key === currentRole ? 'active' : ''}" data-role="${role.key}">
                  <span class="material-icons">${role.key === currentRole ? 'radio_button_checked' : 'radio_button_unchecked'}</span>
                  <span class="btn-label">${role.displayName}</span>
                </button>
              `).join('')}
            </div>
            ${isOverridden ? `
            <div class="mt-16 text-center">
              <button class="btn" id="btn-reset-role" style="display:inline-flex;max-width:300px;">
                <span class="material-icons">restart_alt</span>
                <span class="btn-label">Reset to Default Role</span>
              </button>
            </div>` : ''}
          </div>

          <div class="control-section col-span-6">
            <div class="section-title">System Health</div>
            <div class="text-center">
              <button class="btn" id="btn-open-health" style="display:inline-flex;">
                <span class="material-icons">monitor_heart</span>
                <span class="btn-label">Open Health Dashboard</span>
              </button>
            </div>
          </div>

          <div class="control-section col-span-6">
            <div class="section-title">Home Assistant</div>
            <div class="control-grid" style="grid-template-columns:1fr 1fr;">
              <button class="btn" id="btn-ha-browse">
                <span class="material-icons">search</span>
                <span class="btn-label">Browse Entities</span>
              </button>
              <button class="btn" id="btn-ha-yaml">
                <span class="material-icons">download</span>
                <span class="btn-label">Download YAML</span>
              </button>
            </div>
          </div>

          <div class="control-section col-span-6">
            <div class="section-title">System Information</div>
            <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 8px;font-size:13px;">
              <div>Version:</div><div id="info-version">--</div>
              <div>Location:</div><div id="info-location">--</div>
              <div>Connection:</div><div id="info-connection">--</div>
              <div>OBS:</div><div id="info-obs">--</div>
              <div>X32:</div><div id="info-x32">--</div>
            </div>
          </div>

          <div class="control-section col-span-6">
            <div class="section-title">Security</div>
            <div class="control-grid" style="grid-template-columns:1fr 1fr 1fr;">
              <button class="btn" id="btn-change-pin"><span class="material-icons">lock</span><span class="btn-label">Change PIN</span></button>
              <button class="btn" id="btn-logout"><span class="material-icons">logout</span><span class="btn-label">Lock Settings</span></button>
              <button class="btn" id="btn-reload-app"><span class="material-icons">refresh</span><span class="btn-label">Reload App</span></button>
            </div>
          </div>

          <div class="control-section">
            <div class="section-title">Logging</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Verbose logging adds detailed request/response info to the server log for troubleshooting AV control issues.
            </div>
            <div style="display:flex;align-items:center;gap:12px;padding:8px 12px;background:#1a1a2e;border-radius:8px;">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:15px;">
                <input type="checkbox" id="toggle-verbose-logging" style="width:20px;height:20px;cursor:pointer;">
                <span>Verbose Logging</span>
              </label>
              <span id="verbose-logging-status" style="font-size:12px;opacity:0.6;"></span>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  init() {
    // ── Tab switching ──────────────────────────────────────────────
    this._activeTab = 'admin';
    document.querySelectorAll('[data-settings-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._switchTab(btn.dataset.settingsTab);
      });
    });

    // ── Power tab ──────────────────────────────────────────────────
    document.getElementById('btn-open-smartthings')?.addEventListener('click', () => this._openSwitchPanel('SmartThings', 'SW_'));
    document.getElementById('btn-open-wattbox')?.addEventListener('click', () => this._openSwitchPanel('WattBox', 'WB_'));
    document.getElementById('btn-open-ecoflow')?.addEventListener('click', () => this._openEcoFlowPanel());

    // ── Thermostats tab ─────────────────────────────────────────────
    this._loadThermostats();

    // ── Audio tab ──────────────────────────────────────────────────
    this.loadMixer();
    this.pollTimer = setInterval(() => this.loadMixer(), 5000);
    this._wireX32QuickActions();

    // ── Schedule tab ───────────────────────────────────────────────
    this.loadSchedules();
    this.loadMacroDropdown();

    document.getElementById('btn-add-schedule')?.addEventListener('click', () => {
      document.getElementById('schedule-form')?.classList.remove('hidden');
    });
    document.getElementById('btn-sched-cancel')?.addEventListener('click', () => {
      document.getElementById('schedule-form')?.classList.add('hidden');
    });
    document.getElementById('btn-sched-save')?.addEventListener('click', () => this.saveSchedule());

    // ── Logs tab ───────────────────────────────────────────────────
    document.getElementById('btn-load-audit')?.addEventListener('click', () => this.loadAuditLog());
    document.getElementById('audit-filter')?.addEventListener('change', () => this.filterAuditLog());

    // ── Admin tab ──────────────────────────────────────────────────
    // Role selection
    document.querySelectorAll('[data-role]').forEach(btn => {
      btn.addEventListener('click', () => {
        const role = btn.dataset.role;
        Auth.setRole(role);
        Router.updateNavVisibility();
        Router.navigate('settings');
        App.updateStatusBar();
        App.showToast('Role set to: ' + Auth.getRoleDisplayName());
      });
    });

    document.getElementById('btn-reset-role')?.addEventListener('click', () => {
      Auth.resetRole();
      Router.updateNavVisibility();
      Router.navigate('settings');
      App.updateStatusBar();
      App.showToast('Role reset to default: ' + Auth.getRoleDisplayName());
    });

    // System info
    const infoVersion = document.getElementById('info-version');
    if (infoVersion) infoVersion.textContent = App.settings?.app?.version || '--';
    const infoLoc = document.getElementById('info-location');
    if (infoLoc) infoLoc.textContent = Auth.getDisplayName();

    // Health dashboard
    document.getElementById('btn-open-health')?.addEventListener('click', () => this.openHealthPanel());

    // HA Entity Browser
    document.getElementById('btn-ha-browse')?.addEventListener('click', () => this.openHABrowserPanel());
    document.getElementById('btn-ha-yaml')?.addEventListener('click', () => this.downloadHAYaml());

    // Logout
    document.getElementById('btn-logout')?.addEventListener('click', () => {
      Auth.logout();
      Router.navigate('home');
      App.showToast('Settings locked');
    });

    // Reload
    document.getElementById('btn-reload-app')?.addEventListener('click', () => location.reload());

    // Verbose logging toggle
    this.loadVerboseLogging();
    document.getElementById('toggle-verbose-logging')?.addEventListener('change', async (e) => {
      try {
        const resp = await fetch('/api/settings/verbose-logging', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ enabled: e.target.checked }),
        });
        const data = await resp.json();
        const statusEl = document.getElementById('verbose-logging-status');
        if (statusEl) statusEl.textContent = data.enabled ? 'Enabled' : 'Disabled';
        App.showToast(data.enabled ? 'Verbose logging enabled' : 'Verbose logging disabled');
      } catch (err) {
        App.showToast('Failed to update logging setting');
        e.target.checked = !e.target.checked;
      }
    });
  },

  // =====================================================================
  // Tab Switching
  // =====================================================================

  _switchTab(tab) {
    this._activeTab = tab;

    // Update tab button states
    document.querySelectorAll('[data-settings-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.settingsTab === tab);
    });

    // Show/hide tab content
    document.querySelectorAll('.settings-tab-content').forEach(el => {
      el.style.display = 'none';
    });
    const activeContent = document.getElementById(`settings-tab-${tab}`);
    if (activeContent) activeContent.style.display = '';
  },

  // =====================================================================
  // Power Tab — SmartThings / WattBox Switch Panel
  // =====================================================================

  _switchPanelTimer: null,

  async _openSwitchPanel(title, prefix) {
    const self = this;
    const tabletId = localStorage.getItem('tabletId') || 'WebApp';

    App.showPanel(title, async (body) => {
      body.innerHTML = '<div class="text-center" style="padding:30px;opacity:0.5;">Loading switches...</div>';

      const renderSwitches = async () => {
        try {
          const resp = await fetch(`/api/ha/entities?domain=switch&q=${prefix}`, {
            headers: { 'X-Tablet-ID': tabletId },
          });
          const data = await resp.json();
          if (data.error) {
            body.innerHTML = `<div style="color:var(--danger);padding:16px;">${data.error}</div>`;
            return;
          }

          const entities = [];
          const prefixLower = prefix.toLowerCase();
          for (const [, info] of Object.entries(data.domains || {})) {
            for (const ent of (info.entities || [])) {
              if (ent.entity_id.toLowerCase().includes(prefixLower)) entities.push(ent);
            }
          }

          entities.sort((a, b) => (a.friendly_name || a.entity_id).localeCompare(b.friendly_name || b.entity_id));

          if (entities.length === 0) {
            body.innerHTML = `<div style="opacity:0.5;padding:20px;text-align:center;">No ${title} switches found (switch.${prefix}*).</div>`;
            return;
          }

          body.innerHTML = `
            <div style="margin-bottom:12px;font-size:13px;opacity:0.6;">${entities.length} switches</div>
            <div class="switch-panel-grid">
              ${entities.map(e => {
                const isOn = e.state === 'on';
                const raw = e.friendly_name || e.entity_id.split('.').pop() || e.entity_id;
                const name = raw.replace(/^SW[_ ]|^WB[_ ]/i, '').replace(/_/g, ' ');
                return `<div class="switch-card ${isOn ? 'switch-on' : 'switch-off'}">
                  <div class="switch-info">
                    <span class="status-dot ${isOn ? 'idle' : 'offline'}"></span>
                    <span class="switch-name">${name}</span>
                  </div>
                  <button class="btn switch-toggle ${isOn ? 'active' : ''}" data-switch-entity="${e.entity_id}">
                    <span class="material-icons">${isOn ? 'toggle_on' : 'toggle_off'}</span>
                  </button>
                </div>`;
              }).join('')}
            </div>
          `;

          // Wire toggle handlers
          body.querySelectorAll('[data-switch-entity]').forEach(btn => {
            btn.addEventListener('click', async () => {
              const entityId = btn.dataset.switchEntity;
              btn.disabled = true;
              try {
                await fetch(`/api/ha/service/switch/toggle`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': tabletId },
                  body: JSON.stringify({ entity_id: entityId }),
                });
                // Refresh after short delay to let HA update
                setTimeout(() => renderSwitches(), 800);
              } catch (err) {
                App.showToast('Failed to toggle switch');
                btn.disabled = false;
              }
            });
          });

        } catch (err) {
          body.innerHTML = '<div style="color:var(--danger);padding:16px;">Failed to load switches. Is Home Assistant connected?</div>';
        }
      };

      await renderSwitches();

      // Auto-refresh every 5 seconds while panel is open
      self._switchPanelTimer = setInterval(() => {
        if (!body.isConnected) {
          clearInterval(self._switchPanelTimer);
          self._switchPanelTimer = null;
          return;
        }
        renderSwitches();
      }, 5000);
    });
  },

  // =====================================================================
  // Power Tab — EcoFlow Battery Panel
  // =====================================================================

  _ecoFlowBatteries: [
    { id: 'bat_chapeltv_1', label: 'Chapel TV 1' },
    { id: 'bat_chapeltv_2', label: 'Chapel TV 2' },
    { id: 'bat_mainchurchtv_1', label: 'Main Church TV 1' },
    { id: 'bat_mainchurchtv_2', label: 'Main Church TV 2' },
  ],
  _ecoFlowTimer: null,

  async _openEcoFlowPanel() {
    const self = this;
    const tabletId = localStorage.getItem('tabletId') || 'WebApp';

    App.showPanel('EcoFlow Batteries', async (body) => {
      body.innerHTML = '<div class="text-center" style="padding:30px;opacity:0.5;">Loading batteries...</div>';

      const renderBatteries = async () => {
        try {
          // Fetch all battery entities in one call (no domain filter — need both switch + sensor)
          const resp = await fetch('/api/ha/entities?q=bat_', {
            headers: { 'X-Tablet-ID': tabletId },
          });
          const data = await resp.json();

          // Build a flat lookup map of entity_id → entity
          const entityMap = {};
          for (const [, info] of Object.entries(data.domains || {})) {
            for (const ent of (info.entities || [])) {
              entityMap[ent.entity_id] = ent;
            }
          }

          body.innerHTML = `
            <div style="margin-bottom:12px;font-size:13px;opacity:0.6;">${self._ecoFlowBatteries.length} batteries</div>
            <div class="ecoflow-grid">
              ${self._ecoFlowBatteries.map(bat => {
                const acEntity = entityMap[`switch.${bat.id}_ac_enabled`];
                const dcEntity = entityMap[`switch.${bat.id}_dc_12v_enabled`];
                const levelEntity = entityMap[`sensor.${bat.id}_main_battery_level`];

                const acOn = acEntity?.state === 'on';
                const dcOn = dcEntity?.state === 'on';
                const level = levelEntity ? parseInt(levelEntity.state) : null;
                const levelStr = level != null && !isNaN(level) ? level + '%' : '--';

                // Color code battery level
                let levelColor = 'var(--ok)';
                if (level != null) {
                  if (level <= 20) levelColor = 'var(--danger)';
                  else if (level <= 50) levelColor = 'var(--warn)';
                }

                return `<div class="ecoflow-card">
                  <div class="ecoflow-header">
                    <span class="material-icons" style="font-size:20px;">battery_charging_full</span>
                    <span class="ecoflow-label">${bat.label}</span>
                    <span class="ecoflow-level" style="color:${levelColor};">${levelStr}</span>
                  </div>
                  <div class="ecoflow-bar-track">
                    <div class="ecoflow-bar-fill" style="width:${level != null ? level : 0}%;background:${levelColor};"></div>
                  </div>
                  <div class="ecoflow-switches">
                    <button class="btn ecoflow-toggle ${acOn ? 'active' : ''}" data-ecoflow-entity="${acEntity?.entity_id || ''}" ${!acEntity ? 'disabled' : ''}>
                      <span class="material-icons">${acOn ? 'toggle_on' : 'toggle_off'}</span>
                      <span class="btn-label">AC Output</span>
                    </button>
                    <button class="btn ecoflow-toggle ${dcOn ? 'active' : ''}" data-ecoflow-entity="${dcEntity?.entity_id || ''}" ${!dcEntity ? 'disabled' : ''}>
                      <span class="material-icons">${dcOn ? 'toggle_on' : 'toggle_off'}</span>
                      <span class="btn-label">DC 12V</span>
                    </button>
                  </div>
                </div>`;
              }).join('')}
            </div>
          `;

          // Wire toggle handlers
          body.querySelectorAll('[data-ecoflow-entity]').forEach(btn => {
            if (!btn.dataset.ecoflowEntity) return;
            btn.addEventListener('click', async () => {
              btn.disabled = true;
              try {
                await fetch('/api/ha/service/switch/toggle', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': tabletId },
                  body: JSON.stringify({ entity_id: btn.dataset.ecoflowEntity }),
                });
                setTimeout(() => renderBatteries(), 800);
              } catch (err) {
                App.showToast('Failed to toggle switch');
                btn.disabled = false;
              }
            });
          });

        } catch (err) {
          body.innerHTML = '<div style="color:var(--danger);padding:16px;">Failed to load batteries. Is Home Assistant connected?</div>';
        }
      };

      await renderBatteries();

      self._ecoFlowTimer = setInterval(() => {
        if (!body.isConnected) {
          clearInterval(self._ecoFlowTimer);
          self._ecoFlowTimer = null;
          return;
        }
        renderBatteries();
      }, 5000);
    });
  },

  // =====================================================================
  // Thermostats Tab — Inline thermostat dials
  // =====================================================================

  _thermostatEntities: [
    { entity_id: 'climate.chapel_and_main_hallway', label: 'Chapel & Main Hallway' },
    { entity_id: 'climate.mainchurch', label: 'Main Church' },
    { entity_id: 'climate.social_hall_new', label: 'Social Hall' },
    { entity_id: 'climate.sunday_school', label: 'Sunday School' },
  ],
  _thermostatTimers: [],

  async _loadThermostats() {
    const grid = document.getElementById('thermostats-grid');
    if (!grid) return;
    const tabletId = localStorage.getItem('tabletId') || 'WebApp';
    const self = this;

    grid.innerHTML = self._thermostatEntities.map((t, i) =>
      `<div class="control-section col-span-6" id="thermo-section-${i}">
        <div class="section-title">${t.label}</div>
        <div class="text-center" style="opacity:0.5;padding:20px;" id="thermo-body-${i}">Loading...</div>
      </div>`
    ).join('');

    // Load each thermostat in parallel
    self._thermostatEntities.forEach((t, i) => {
      self._loadSingleThermostat(t.entity_id, i, tabletId);
    });
  },

  async _loadSingleThermostat(entityId, index, tabletId) {
    const body = document.getElementById(`thermo-body-${index}`);
    if (!body) return;
    const self = this;

    let state;
    try {
      const resp = await fetch(`/api/ha/states/${entityId}`, {
        headers: { 'X-Tablet-ID': tabletId },
      });
      if (!resp.ok) {
        body.innerHTML = `<div style="color:var(--danger);">Failed to load (${resp.status})</div>`;
        return;
      }
      state = await resp.json();
    } catch (e) {
      body.innerHTML = '<div style="color:var(--danger);">Failed to load thermostat</div>';
      return;
    }

    if (state.error) {
      body.innerHTML = `<div style="color:var(--danger);">${state.error}</div>`;
      return;
    }

    const attrs = state.attributes || {};
    const currentTemp = attrs.current_temperature != null ? Math.round(attrs.current_temperature) : '--';
    let targetTemp = 72;
    if (attrs.temperature != null) targetTemp = Math.round(attrs.temperature);
    else if (attrs.target_temp_high != null && attrs.target_temp_low != null) targetTemp = Math.round((attrs.target_temp_high + attrs.target_temp_low) / 2);
    else if (currentTemp !== '--') targetTemp = currentTemp;

    const hvacMode = state.state || 'off';
    const hvacModes = attrs.hvac_modes || ['off', 'heat', 'cool'];
    const minTemp = attrs.min_temp || 45;
    const maxTemp = attrs.max_temp || 95;
    const hvacAction = attrs.hvac_action || '';
    const humidity = attrs.current_humidity;

    let _target = targetTemp;
    let _mode = hvacMode;

    // Use MacroAPI's thermostat rendering helpers
    body.style.padding = '12px';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.alignItems = 'center';
    body.style.opacity = '1';

    body.innerHTML = MacroAPI._thermostatHTML(_target, currentTemp, _mode, hvacAction, minTemp, maxTemp, hvacModes, humidity);

    // Make IDs unique per thermostat to avoid conflicts
    const uniquify = (el) => {
      el.querySelectorAll('[id]').forEach(node => {
        node.id = node.id + '-' + index;
      });
    };
    uniquify(body);

    // Wire events manually (adapted from MacroAPI._wireThermostatEvents)
    const svg = body.querySelector(`#thermo-svg-${index}`);
    const dot = body.querySelector(`#thermo-dot-${index}`);
    const arc = body.querySelector(`#thermo-arc-${index}`);
    const targetText = body.querySelector(`#thermo-target-${index}`);
    const CX = 140, CY = 140, R = 120;
    const START_ANGLE = 135, END_ANGLE = 405, RANGE = END_ANGLE - START_ANGLE;

    let sendTimer = null;

    const updateVisual = () => {
      const frac = (_target - minTemp) / (maxTemp - minTemp);
      const angle = START_ANGLE + frac * RANGE;
      const rad = angle * Math.PI / 180;
      const dotX = CX + R * Math.cos(rad);
      const dotY = CY + R * Math.sin(rad);
      const modeColor = _mode === 'heat' ? '#ff6b35' : _mode === 'cool' ? '#4dabf7' : '#888';

      if (dot) { dot.setAttribute('cx', dotX); dot.setAttribute('cy', dotY); dot.setAttribute('fill', modeColor); }
      if (arc) {
        const startRad = START_ANGLE * Math.PI / 180;
        const endRad = Math.min(angle, END_ANGLE) * Math.PI / 180;
        const sx = CX + R * Math.cos(startRad), sy = CY + R * Math.sin(startRad);
        const ex = CX + R * Math.cos(endRad), ey = CY + R * Math.sin(endRad);
        const sweep = (angle - START_ANGLE) > 180 ? 1 : 0;
        arc.setAttribute('d', `M ${sx} ${sy} A ${R} ${R} 0 ${sweep} 1 ${ex} ${ey}`);
        arc.setAttribute('stroke', modeColor);
      }
      if (targetText) targetText.textContent = _target + '\u00B0';
    };

    const scheduleSet = () => {
      clearTimeout(sendTimer);
      sendTimer = setTimeout(async () => {
        try {
          await fetch('/api/ha/service/climate/set_temperature', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': tabletId },
            body: JSON.stringify({ entity_id: entityId, temperature: _target }),
          });
        } catch (e) { console.error('set_temperature error:', e); }
      }, 600);
    };

    // +/- buttons
    body.querySelector(`#thermo-minus-${index}`)?.addEventListener('click', () => {
      if (_target > minTemp) { _target--; updateVisual(); scheduleSet(); }
    });
    body.querySelector(`#thermo-plus-${index}`)?.addEventListener('click', () => {
      if (_target < maxTemp) { _target++; updateVisual(); scheduleSet(); }
    });

    // Drag on SVG
    if (svg) {
      let dragging = false;
      const angleFromPoint = (px, py) => {
        const rect = svg.getBoundingClientRect();
        const svgW = parseFloat(svg.getAttribute('width')) || 280;
        const svgH = parseFloat(svg.getAttribute('height')) || 280;
        const scaleX = svgW / rect.width;
        const scaleY = svgH / rect.height;
        const x = (px - rect.left) * scaleX;
        const y = (py - rect.top) * scaleY;
        let deg = Math.atan2(y - CY, x - CX) * 180 / Math.PI;
        if (deg < 0) deg += 360;
        if (deg < START_ANGLE) deg += 360;
        return deg;
      };
      const clampToTemp = (deg) => {
        let d = deg;
        if (d < START_ANGLE) d = START_ANGLE;
        if (d > END_ANGLE) d = END_ANGLE;
        const frac2 = (d - START_ANGLE) / RANGE;
        return Math.round(minTemp + frac2 * (maxTemp - minTemp));
      };
      const onStart = (e) => {
        const t = e.target;
        if (t === dot || t.closest?.(`#thermo-dot-${index}`)) { dragging = true; e.preventDefault(); }
      };
      const onMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const pt = e.touches ? e.touches[0] : e;
        const deg = angleFromPoint(pt.clientX, pt.clientY);
        _target = clampToTemp(deg);
        updateVisual();
      };
      const onEnd = () => { if (dragging) { dragging = false; scheduleSet(); } };
      svg.addEventListener('mousedown', onStart);
      svg.addEventListener('mousemove', onMove);
      svg.addEventListener('mouseup', onEnd);
      svg.addEventListener('mouseleave', onEnd);
      svg.addEventListener('touchstart', onStart, { passive: false });
      svg.addEventListener('touchmove', onMove, { passive: false });
      svg.addEventListener('touchend', onEnd);
    }

    // Mode buttons
    body.querySelectorAll('.thermo-mode-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newMode = btn.dataset.mode;
        _mode = newMode;
        body.querySelectorAll('.thermo-mode-btn').forEach(b => {
          b.classList.remove('active');
          b.style.background = '';
          b.style.color = '';
        });
        const activeColor = newMode === 'heat' ? '#ff6b35' : newMode === 'cool' ? '#4dabf7' : 'var(--accent)';
        btn.classList.add('active');
        btn.style.background = activeColor;
        btn.style.color = '#fff';
        updateVisual();
        try {
          await fetch('/api/ha/service/climate/set_hvac_mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': tabletId },
            body: JSON.stringify({ entity_id: entityId, hvac_mode: newMode }),
          });
        } catch (e) { console.error('set_hvac_mode error:', e); }
      });
    });

    // Poll for live updates
    const pollTimer = setInterval(async () => {
      if (!body.isConnected) { clearInterval(pollTimer); return; }
      try {
        const r = await fetch(`/api/ha/states/${entityId}`, { headers: { 'X-Tablet-ID': tabletId } });
        const s = await r.json();
        const a = s.attributes || {};
        const curEl = body.querySelector(`#thermo-current-${index}`);
        const actionEl = body.querySelector(`#thermo-action-${index}`);
        const humEl = body.querySelector(`#thermo-humidity-${index}`);
        if (curEl && a.current_temperature != null) curEl.textContent = Math.round(a.current_temperature) + '\u00B0';
        if (actionEl) actionEl.textContent = MacroAPI._hvacActionLabel(a.hvac_action || '');
        if (humEl && a.current_humidity != null) humEl.textContent = Math.round(a.current_humidity) + '% humidity';
      } catch (e) { /* ignore poll errors */ }
    }, 10000);
    self._thermostatTimers.push(pollTimer);
  },

  // =====================================================================
  // Existing methods (unchanged)
  // =====================================================================

  _auditData: [],

  async loadVerboseLogging() {
    try {
      const resp = await fetch('/api/settings/verbose-logging', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const data = await resp.json();
      const toggle = document.getElementById('toggle-verbose-logging');
      const status = document.getElementById('verbose-logging-status');
      if (toggle) toggle.checked = data.enabled;
      if (status) status.textContent = data.enabled ? 'Enabled' : 'Disabled';
    } catch (e) {
      // Silently fail — toggle defaults to unchecked
    }
  },

  async loadAuditLog() {
    try {
      const [logsResp, sessionsResp] = await Promise.all([
        fetch('/api/audit/logs?limit=200', { headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' } }),
        fetch('/api/audit/sessions', { headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' } }),
      ]);
      this._auditData = await logsResp.json();
      const sessions = await sessionsResp.json();

      document.getElementById('audit-container')?.classList.remove('hidden');
      this.renderAuditLog(this._auditData);
      this.renderSessions(sessions);
    } catch (e) {
      App.showToast('Failed to load audit log');
    }
  },

  renderAuditLog(logs) {
    const container = document.getElementById('audit-log');
    const countEl = document.getElementById('audit-count');
    if (!container) return;

    if (countEl) countEl.textContent = `${logs.length} entries`;

    if (logs.length === 0) {
      container.innerHTML = '<div style="opacity:0.5;padding:8px;">No activity recorded yet.</div>';
      return;
    }

    container.innerHTML = logs.map(log => {
      const ts = log.timestamp ? log.timestamp.replace('T', ' ').substring(5, 19) : '--';
      const tablet = (log.tablet_id || '').replace('Tablet_', '');
      const latency = log.latency_ms ? `${Math.round(log.latency_ms)}ms` : '';
      const resultShort = (log.result || '').substring(0, 60);
      return `<div class="audit-row" style="display:flex;gap:8px;padding:4px 0;border-bottom:1px solid #333;">
        <span style="color:#888;min-width:90px;">${ts}</span>
        <span style="color:#4fc3f7;min-width:80px;">${tablet}</span>
        <span style="color:#fff;min-width:140px;">${log.action || ''}</span>
        <span style="color:#aaa;min-width:80px;">${log.target || ''}</span>
        <span style="color:#81c784;">${latency}</span>
        <span style="color:#666;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${resultShort}</span>
      </div>`;
    }).join('');
  },

  filterAuditLog() {
    const filter = document.getElementById('audit-filter')?.value || '';
    if (!filter) {
      this.renderAuditLog(this._auditData);
      return;
    }
    const filtered = this._auditData.filter(log => (log.action || '').startsWith(filter));
    this.renderAuditLog(filtered);
  },

  renderSessions(sessions) {
    const container = document.getElementById('sessions-container');
    if (!container) return;

    if (!sessions || sessions.length === 0) {
      container.innerHTML = '<div style="opacity:0.5;font-size:14px;">No connected tablets.</div>';
      return;
    }

    container.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:13px;">
      ${sessions.map(s => {
        const name = (s.tablet_id || '').replace('Tablet_', '');
        const page = s.current_page || '--';
        const seen = s.last_seen ? s.last_seen.replace('T', ' ').substring(5, 19) : '--';
        return `<div style="background:#1a1a2e;padding:8px;border-radius:6px;">
          <div style="font-weight:bold;color:#4fc3f7;">${name}</div>
          <div style="color:#aaa;">Page: ${page}</div>
          <div style="color:#666;font-size:11px;">Seen: ${seen}</div>
        </div>`;
      }).join('')}
    </div>`;
  },

  async loadMixer() {
    const state = await X32API.poll();
    const container = document.getElementById('mixer-container');
    if (!container) return;

    if (!state.online) {
      container.innerHTML = '<div class="text-center" style="color:#cc0000;">X32 Mixer Offline</div>';
      const infoX32 = document.getElementById('info-x32');
      if (infoX32) infoX32.textContent = 'Offline';
      return;
    }

    const infoX32 = document.getElementById('info-x32');
    if (infoX32) infoX32.textContent = 'Online - Scene: ' + (state.currentSceneName || '--');

    // Render channels
    const activeChannels = state.channels.filter(ch => ch.name && ch.name.trim() !== '');
    container.innerHTML = `
      <div class="mixer-grid">
        ${activeChannels.map(ch => `
          <div class="mixer-channel">
            <div class="channel-name" title="${ch.name}">${ch.name}</div>
            <input type="range" class="channel-fader" min="0" max="100" value="${Math.round(ch.volume * 100)}"
              data-ch="${ch.id}" orient="vertical" />
            <div class="channel-volume">${Math.round(ch.volume * 100)}%</div>
            <button class="channel-mute ${ch.muted === 'ON' || ch.muted === '1' ? 'muted' : 'unmuted'}" data-mute-ch="${ch.id}">
              ${ch.muted === 'ON' || ch.muted === '1' ? 'MUTED' : 'ON'}
            </button>
          </div>
        `).join('')}
      </div>
    `;

    // Mute handlers
    container.querySelectorAll('[data-mute-ch]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const chId = parseInt(btn.dataset.muteCh);
        const ch = state.channels.find(c => c.id === chId);
        if (ch && (ch.muted === 'ON' || ch.muted === '1')) {
          await X32API.unmuteChannel(chId);
        } else {
          await X32API.muteChannel(chId);
        }
        setTimeout(() => this.loadMixer(), 500);
      });
    });

    // Volume handlers
    container.querySelectorAll('[data-ch]').forEach(fader => {
      fader.addEventListener('input', async () => {
        // Volume changes require the middleware to support it
        // For now just show visual feedback
      });
    });

    // Scenes
    const scenesContainer = document.getElementById('x32-scenes');
    if (scenesContainer) {
      const activeScenes = state.scenes.filter(s => s.name && s.name.trim() !== '');
      scenesContainer.innerHTML = activeScenes.map(s => `
        <button class="btn scene-btn ${String(state.currentScene) === String(s.id) ? 'active-scene' : ''}" data-x32-scene="${s.id}">
          <span class="btn-label">${s.name}</span>
        </button>
      `).join('');

      scenesContainer.querySelectorAll('[data-x32-scene]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await X32API.loadScene(parseInt(btn.dataset.x32Scene));
          App.showToast('Loading scene...');
          setTimeout(() => this.loadMixer(), 1000);
        });
      });
    }

    // Aux channels
    const auxContainer = document.getElementById('aux-container');
    if (auxContainer) {
      const activeAux = state.auxChannels.filter(a => a.name && a.name.trim() !== '');
      auxContainer.innerHTML = activeAux.map(a => `
        <div class="mixer-channel">
          <div class="channel-name" title="${a.name}">${a.name}</div>
          <div class="channel-volume">${Math.round(a.volume * 100)}%</div>
          <button class="channel-mute ${a.muted === 'ON' || a.muted === '1' ? 'muted' : 'unmuted'}" data-mute-aux="${a.id}">
            ${a.muted === 'ON' || a.muted === '1' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      auxContainer.querySelectorAll('[data-mute-aux]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const auxId = parseInt(btn.dataset.muteAux);
          const aux = state.auxChannels.find(a => a.id === auxId);
          if (aux && (aux.muted === 'ON' || aux.muted === '1')) {
            await X32API.unmuteAux(auxId);
          } else {
            await X32API.muteAux(auxId);
          }
          setTimeout(() => this.loadMixer(), 500);
        });
      });
    }
  },

  _wireX32QuickActions() {
    document.getElementById('x32-mute-all')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Mute ALL input channels?')) return;
      const state = X32API.state;
      for (const ch of state.channels) {
        if (ch.name && ch.name.trim() !== '' && ch.muted !== 'ON' && ch.muted !== '1') {
          await X32API.muteChannel(ch.id);
        }
      }
      App.showToast('All channels muted');
      setTimeout(() => this.loadMixer(), 500);
    });

    document.getElementById('x32-unmute-all')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Unmute ALL input channels?')) return;
      const state = X32API.state;
      for (const ch of state.channels) {
        if (ch.name && ch.name.trim() !== '' && (ch.muted === 'ON' || ch.muted === '1')) {
          await X32API.unmuteChannel(ch.id);
        }
      }
      App.showToast('All channels unmuted');
      setTimeout(() => this.loadMixer(), 500);
    });

    document.getElementById('x32-reload-scene')?.addEventListener('click', async () => {
      const scene = X32API.state.currentScene;
      if (!scene && scene !== 0) {
        App.showToast('No active scene to reload', 2000, 'error');
        return;
      }
      await X32API.loadScene(parseInt(scene));
      App.showToast('Reloading current scene...');
      setTimeout(() => this.loadMixer(), 1000);
    });

    document.getElementById('x32-mute-band')?.addEventListener('click', async () => {
      // Toggle mute on channels whose names suggest music/band/instruments
      const musicPatterns = /guitar|bass|drum|key|piano|organ|band|music|inst|synth/i;
      const state = X32API.state;
      const musicChs = state.channels.filter(ch => ch.name && musicPatterns.test(ch.name));
      if (musicChs.length === 0) {
        App.showToast('No music/band channels found');
        return;
      }
      const anyUnmuted = musicChs.some(ch => ch.muted !== 'ON' && ch.muted !== '1');
      for (const ch of musicChs) {
        if (anyUnmuted) {
          await X32API.muteChannel(ch.id);
        } else {
          await X32API.unmuteChannel(ch.id);
        }
      }
      App.showToast(anyUnmuted ? 'Music channels muted' : 'Music channels unmuted');
      setTimeout(() => this.loadMixer(), 500);
    });
  },

  // -----------------------------------------------------------------------
  // Schedule management
  // -----------------------------------------------------------------------

  async loadSchedules() {
    const container = document.getElementById('schedule-container');
    if (!container) return;
    try {
      const resp = await fetch('/api/schedules', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const schedules = await resp.json();
      this.renderSchedules(schedules);
    } catch (e) {
      container.innerHTML = '<div style="opacity:0.5;">Failed to load schedules.</div>';
    }
  },

  renderSchedules(schedules) {
    const container = document.getElementById('schedule-container');
    if (!container) return;

    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    if (!schedules || schedules.length === 0) {
      container.innerHTML = '<div style="opacity:0.5;font-size:14px;text-align:center;">No scheduled automations yet.</div>';
      return;
    }

    container.innerHTML = schedules.map(s => {
      const days = (s.days || '').split(',').map(d => dayNames[parseInt(d)] || '?').join(', ');
      const enabledClass = s.enabled ? 'text-green' : 'text-red';
      const enabledLabel = s.enabled ? 'Enabled' : 'Disabled';
      return `<div class="health-item" style="margin-bottom:6px;">
        <div>
          <div class="health-name">${s.name}</div>
          <div style="font-size:12px;color:#aaa;">
            ${s.macro_key} &middot; ${s.time_of_day} &middot; ${days}
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="${enabledClass}" style="font-size:12px;font-weight:bold;">${enabledLabel}</span>
          <button class="btn" data-toggle-sched="${s.id}" data-enabled="${s.enabled}"
            style="min-height:auto;padding:6px 10px;font-size:11px;">
            <span class="material-icons" style="font-size:16px;">${s.enabled ? 'pause' : 'play_arrow'}</span>
          </button>
          <button class="btn btn-danger" data-delete-sched="${s.id}"
            style="min-height:auto;padding:6px 10px;font-size:11px;">
            <span class="material-icons" style="font-size:16px;">delete</span>
          </button>
        </div>
      </div>`;
    }).join('');

    // Toggle enable/disable
    container.querySelectorAll('[data-toggle-sched]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.toggleSched;
        const currentlyEnabled = btn.dataset.enabled === '1';
        await fetch(`/api/schedule/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          body: JSON.stringify({ enabled: !currentlyEnabled }),
        });
        this.loadSchedules();
      });
    });

    // Delete
    container.querySelectorAll('[data-delete-sched]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteSched;
        if (!await App.showConfirm('Delete this scheduled automation?')) return;
        await fetch(`/api/schedule/${id}`, {
          method: 'DELETE',
          headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
        });
        this.loadSchedules();
      });
    });
  },

  async loadMacroDropdown() {
    const select = document.getElementById('sched-macro');
    if (!select) return;
    try {
      const resp = await fetch('/api/macros', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const data = await resp.json();
      const macros = data.macros || {};
      select.innerHTML = Object.entries(macros).map(([key, m]) =>
        `<option value="${key}">${m.label || key}</option>`
      ).join('');
    } catch (e) {
      select.innerHTML = '<option value="">Failed to load macros</option>';
    }
  },

  async saveSchedule() {
    const name = document.getElementById('sched-name')?.value?.trim();
    const macro = document.getElementById('sched-macro')?.value;
    const time = document.getElementById('sched-time')?.value;
    const dayCheckboxes = document.querySelectorAll('#sched-days input[type="checkbox"]:checked');
    const days = Array.from(dayCheckboxes).map(cb => cb.value).join(',');

    if (!name || !macro) {
      App.showToast('Name and macro are required');
      return;
    }

    try {
      await fetch('/api/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
        body: JSON.stringify({ name, macro, time, days }),
      });
      document.getElementById('schedule-form')?.classList.add('hidden');
      document.getElementById('sched-name').value = '';
      App.showToast('Schedule created');
      this.loadSchedules();
    } catch (e) {
      App.showToast('Failed to create schedule', 3000, 'error');
    }
  },

  // -----------------------------------------------------------------------
  // Health Dashboard Panel
  // -----------------------------------------------------------------------

  openHealthPanel() {
    const url = HealthAPI.getStatusUrl();

    App.showPanel('System Health', (body) => {
      body.style.padding = '0';
      body.innerHTML = `
        <iframe id="health-iframe" src="${url}"
          style="width:100%;height:100%;border:none;border-radius:0 0 16px 16px;">
        </iframe>
      `;
    });
  },

  // -----------------------------------------------------------------------
  // HA Entity Browser
  // -----------------------------------------------------------------------

  _haDomainSummary: null,
  _haSearchTimer: null,

  async openHABrowserPanel() {
    const self = this;

    App.showPanel('Home Assistant Entities', async (body) => {
      body.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">
          <input type="text" id="ha-search" placeholder="Search entities (e.g. switch, ecoflow, climate)..."
            style="flex:1;min-width:200px;padding:8px 12px;border-radius:6px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:14px;font-family:inherit;">
          <select id="ha-domain-filter" style="padding:8px;border-radius:6px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;">
            <option value="">All Domains</option>
          </select>
          <span id="ha-entity-count" style="font-size:12px;opacity:0.6;white-space:nowrap;"></span>
        </div>
        <div id="ha-results">
          <div style="opacity:0.5;padding:20px;text-align:center;">
            Select a domain or type a search query to browse entities.
          </div>
        </div>
      `;

      body.querySelector('#ha-search').addEventListener('input', () => {
        clearTimeout(self._haSearchTimer);
        self._haSearchTimer = setTimeout(() => self._fetchAndRenderEntities(body), 400);
      });
      body.querySelector('#ha-domain-filter').addEventListener('change', () => self._fetchAndRenderEntities(body));

      if (!self._haDomainSummary) {
        try {
          const resp = await fetch('/api/ha/entities', {
            headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          });
          const data = await resp.json();
          if (data.domains) {
            self._haDomainSummary = {};
            for (const [d, info] of Object.entries(data.domains)) {
              self._haDomainSummary[d] = info.count;
            }
          }
        } catch (e) {
          body.querySelector('#ha-results').innerHTML = '<div style="color:var(--danger);padding:8px;">Failed to load domains. Is the gateway running?</div>';
          return;
        }
      }

      const domainSelect = body.querySelector('#ha-domain-filter');
      if (domainSelect && self._haDomainSummary) {
        const totalEntities = Object.values(self._haDomainSummary).reduce((a, b) => a + b, 0);
        const domains = Object.keys(self._haDomainSummary).sort();
        domainSelect.innerHTML = '<option value="">All Domains (' + totalEntities + ' entities)</option>' +
          domains.map(d => `<option value="${d}">${d} (${self._haDomainSummary[d]})</option>`).join('');
      }

      const countEl = body.querySelector('#ha-entity-count');
      if (countEl && self._haDomainSummary) {
        const total = Object.values(self._haDomainSummary).reduce((a, b) => a + b, 0);
        countEl.textContent = `${total} total entities`;
      }
    });
  },

  async _fetchAndRenderEntities(container) {
    const results = container.querySelector('#ha-results');
    const countEl = container.querySelector('#ha-entity-count');
    if (!results) return;

    const query = (container.querySelector('#ha-search')?.value || '').trim();
    const domainFilter = container.querySelector('#ha-domain-filter')?.value || '';

    if (!domainFilter && query.length < 2) {
      results.innerHTML = '<div style="opacity:0.5;padding:20px;text-align:center;">Select a domain or type at least 2 characters to search.</div>';
      if (countEl && this._haDomainSummary) {
        const total = Object.values(this._haDomainSummary).reduce((a, b) => a + b, 0);
        countEl.textContent = `${total} total entities`;
      }
      return;
    }

    results.innerHTML = '<div style="opacity:0.5;padding:8px;">Loading entities...</div>';

    const params = new URLSearchParams();
    if (domainFilter) params.set('domain', domainFilter);
    if (query) params.set('q', query);

    try {
      const resp = await fetch(`/api/ha/entities?${params.toString()}`, {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const data = await resp.json();
      if (data.error) {
        results.innerHTML = `<div style="color:var(--danger);padding:8px;">${data.error}</div>`;
        return;
      }
      this._renderHAResults(container, data);
    } catch (e) {
      results.innerHTML = '<div style="color:var(--danger);padding:8px;">Failed to load entities.</div>';
    }
  },

  _renderHAResults(container, data) {
    const results = container.querySelector('#ha-results');
    const countEl = container.querySelector('#ha-entity-count');
    if (!results || !data?.domains) return;

    let entities = [];
    for (const [domain, info] of Object.entries(data.domains)) {
      for (const ent of (info.entities || [])) {
        entities.push({ ...ent, domain });
      }
    }

    if (countEl) countEl.textContent = `${entities.length} entities`;

    if (entities.length === 0) {
      results.innerHTML = '<div style="opacity:0.5;padding:8px;">No matching entities found.</div>';
      return;
    }

    const capped = entities.slice(0, 200);
    const showMore = entities.length > 200;

    results.innerHTML = `
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="text-align:left;border-bottom:2px solid var(--border);font-size:11px;color:var(--text-secondary);">
            <th style="padding:6px 8px;">Entity ID</th>
            <th style="padding:6px 8px;">Name</th>
            <th style="padding:6px 8px;">State</th>
            <th style="padding:6px 8px;">Attributes</th>
          </tr>
        </thead>
        <tbody>
          ${capped.map(e => {
            const attrs = e.attributes || {};
            const attrKeys = Object.keys(attrs).slice(0, 5);
            const attrStr = attrKeys.map(k => `${k}: ${JSON.stringify(attrs[k])}`).join(', ');
            const truncAttrs = attrStr.length > 120 ? attrStr.substring(0, 120) + '...' : attrStr;
            return `<tr style="border-bottom:1px solid var(--border);" class="ha-entity-row" data-entity-id="${e.entity_id}">
              <td style="padding:6px 8px;color:var(--text);font-weight:bold;cursor:pointer;white-space:nowrap;" title="Click to copy">${e.entity_id}</td>
              <td style="padding:6px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.friendly_name || '--'}</td>
              <td style="padding:6px 8px;font-weight:bold;">${e.state || '--'}</td>
              <td style="padding:6px 8px;color:var(--text-secondary);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${attrStr}">${truncAttrs || '--'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${showMore ? `<div style="padding:8px;opacity:0.6;text-align:center;">Showing first 200 of ${entities.length} — narrow your search to see more.</div>` : ''}
    `;

    results.querySelectorAll('.ha-entity-row td:first-child').forEach(td => {
      td.addEventListener('click', () => {
        const id = td.textContent.trim();
        navigator.clipboard.writeText(id).then(() => {
          App.showToast('Copied: ' + id);
        }).catch(() => {
          App.showToast(id, 3000);
        });
      });
    });
  },

  async downloadHAYaml() {
    try {
      App.showToast('Generating YAML reference...');
      const resp = await fetch('/api/ha/entities/yaml', {
        headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ha_entities_reference.yaml';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      App.showToast('YAML reference downloaded');
    } catch (e) {
      App.showToast('Failed to download YAML', 3000, 'error');
    }
  },

  destroy() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this._switchPanelTimer) { clearInterval(this._switchPanelTimer); this._switchPanelTimer = null; }
    if (this._ecoFlowTimer) { clearInterval(this._ecoFlowTimer); this._ecoFlowTimer = null; }
    this._thermostatTimers.forEach(t => clearInterval(t));
    this._thermostatTimers = [];
    this._haDomainSummary = null;
    clearTimeout(this._haSearchTimer);
  }
};
