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
        <button class="cam-tab" data-settings-tab="config">
          <span class="material-icons">settings_applications</span>
          <span>Config</span>
        </button>
        <button class="cam-tab" data-settings-tab="users">
          <span class="material-icons">people</span>
          <span>Users</span>
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
          <div class="control-section" style="grid-column:1/-1;">
            <div class="section-title" style="color:var(--danger);">
              <span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">emergency</span>
              Break-Glass: Direct Power Control
            </div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Emergency device restart <strong>bypassing Home Assistant</strong>. Use only when HA is down or unresponsive.
            </div>
            <div id="breakglass-devices" class="control-grid" style="grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));">
              <div style="opacity:0.5;padding:12px;">Loading devices…</div>
            </div>
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
            <div class="section-title">Aux Inputs</div>
            <div id="aux-container" class="mixer-grid"></div>
          </div>
          <div class="control-section">
            <div class="section-title">Mix Buses</div>
            <div id="bus-container" class="mixer-grid"></div>
          </div>
          <div class="control-section">
            <div class="section-title">DCA Groups</div>
            <div id="dca-container" class="mixer-grid"></div>
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
        <div class="page-grid" id="tv-controls-grid">
          <div class="text-center" style="opacity:0.5;padding:30px;">Loading TV controls...</div>
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
              <div id="sched-macro-details" class="hidden" style="margin-top:8px;background:#111;border:1px solid #333;border-radius:6px;padding:10px;font-size:12px;">
                <div id="sched-macro-desc" style="color:#ccc;margin-bottom:6px;"></div>
                <details>
                  <summary style="cursor:pointer;color:#ff8c00;font-size:11px;user-select:none;">Show steps</summary>
                  <div id="sched-macro-steps" style="margin-top:6px;color:#aaa;font-size:11px;line-height:1.6;"></div>
                </details>
              </div>
              <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end;">
                <button class="btn" id="btn-sched-cancel" style="min-height:auto;padding:6px 12px;">Cancel</button>
                <button class="btn btn-success" id="btn-sched-save" style="min-height:auto;padding:6px 12px;background:#00b050;border-color:#00b050;"><span class="btn-label">Save</span></button>
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
              <select id="audit-limit" style="padding:6px;border-radius:4px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:13px;margin-right:8px;">
                <option value="500">500 entries</option>
                <option value="1000">1,000 entries</option>
                <option value="2500">2,500 entries</option>
                <option value="5000">5,000 entries</option>
              </select>
              <button class="btn" id="btn-load-audit" style="display:inline-flex;max-width:300px;">
                <span class="material-icons">history</span>
                <span class="btn-label">Load Recent Activity</span>
              </button>
            </div>
            <div id="audit-container" class="hidden">
              <div class="audit-controls" style="display:flex;gap:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap;">
                <select id="audit-filter" style="padding:6px;border-radius:4px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:13px;">
                  <option value="">All Actions</option>
                  <option value="macro:">Macros</option>
                  <option value="schedule:">Schedules</option>
                  <option value="moip:">MoIP</option>
                  <option value="obs:">OBS</option>
                  <option value="ptz:">PTZ</option>
                  <option value="projector:">Projectors</option>
                  <option value="ha:">Home Assistant</option>
                  <option value="x32:">X32 Mixer</option>
                  <option value="fully:">Fully Kiosk</option>
                  <option value="occupancy:">Occupancy</option>
                  <option value="settings:">Settings</option>
                  <option value="__errors__">Errors Only</option>
                </select>
                <select id="audit-actor-filter" style="padding:6px;border-radius:4px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:13px;">
                  <option value="">All Users</option>
                </select>
                <div class="switch-search-bar" style="flex:1;min-width:150px;margin:0;">
                  <span class="material-icons" style="opacity:0.5;font-size:16px;">search</span>
                  <input type="text" class="switch-search-input" id="audit-search" placeholder="Search logs..." style="font-size:12px;">
                </div>
                <span id="audit-count" style="font-size:12px;opacity:0.6;white-space:nowrap;"></span>
              </div>
              <div id="audit-log" style="max-height:400px;overflow-y:auto;font-size:12px;font-family:monospace;"></div>
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
      <!-- CONFIG TAB                                                    -->
      <!-- ============================================================ -->
      <div id="settings-tab-config" class="settings-tab-content" style="display:none;">
        <div class="page-grid" id="config-editor-grid">
          <div class="text-center" style="opacity:0.5;padding:30px;">Loading configuration...</div>
        </div>
        <!-- Entity Find & Replace -->
        <div class="page-grid" style="margin-top:12px;">
          <div class="control-section" style="grid-column:1/-1;">
            <div class="section-title">
              <span class="material-icons" style="font-size:18px;vertical-align:middle;margin-right:4px;">find_replace</span>
              Entity Find &amp; Replace
            </div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Replace switch entity IDs in macros.yaml. A backup is created automatically.
            </div>
            <button class="btn" id="btn-open-entity-fr">
              <span class="material-icons">find_replace</span>
              <span class="btn-label">Open Entity Replace Tool</span>
            </button>
          </div>
        </div>

        <div class="page-grid" style="margin-top:12px;">
          <div class="control-section" style="grid-column:1/-1;">
            <div class="section-title">Apply Changes</div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Save writes to config.yaml (backup created automatically).
              Restart is required for most changes to take effect.
            </div>
            <div class="control-grid" style="grid-template-columns:1fr 1fr;">
              <button class="btn" id="btn-config-save">
                <span class="material-icons">save</span>
                <span class="btn-label">Save Config</span>
              </button>
              <button class="btn danger" id="btn-gateway-restart">
                <span class="material-icons">restart_alt</span>
                <span class="btn-label">Restart Gateway</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- ============================================================ -->
      <!-- USERS TAB                                                     -->
      <!-- ============================================================ -->
      <div id="settings-tab-users" class="settings-tab-content" style="display:none;">
        <div class="page-grid">
          <div class="control-section col-span-6">
            <div class="section-title">
              <span class="material-icons" style="vertical-align:text-bottom;margin-right:4px;font-size:18px;">people</span>
              User Accounts
            </div>
            <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
              Manage user accounts for remote access. Users log in from personal devices with their own credentials and permissions.
            </div>
            <div style="margin-bottom:12px;">
              <button class="btn" id="btn-add-user" style="display:inline-flex;">
                <span class="material-icons">person_add</span>
                <span class="btn-label">Add User</span>
              </button>
            </div>
            <div id="users-list" style="display:grid;gap:8px;">
              <div style="opacity:0.5;padding:12px;text-align:center;">Loading users...</div>
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
        const tab = btn.dataset.settingsTab;
        if (tab === 'config' || tab === 'users') {
          // Config and Users tabs require secure PIN every time
          App.showSecurePINEntry((success) => {
            if (success) {
              this._switchTab(tab);
              if (tab === 'users') this._loadUsers();
            }
          });
          return;
        }
        this._switchTab(tab);
      });
    });

    // ── Power tab ──────────────────────────────────────────────────
    document.getElementById('btn-open-smartthings')?.addEventListener('click', () => this._openSwitchPanel('SmartThings', 'SW_'));
    document.getElementById('btn-open-wattbox')?.addEventListener('click', () => this._openSwitchPanel('WattBox', 'WB_'));
    document.getElementById('btn-open-ecoflow')?.addEventListener('click', () => this._openEcoFlowPanel());
    this._loadBreakGlassDevices();

    // ── Thermostats tab ─────────────────────────────────────────────
    this._loadThermostats();

    // ── TV's tab ──────────────────────────────────────────────────
    this._loadTVControls();

    // ── Audio tab ──────────────────────────────────────────────────
    this.loadMixer();
    this._wireX32QuickActions();

    // ── Schedule tab ───────────────────────────────────────────────
    this.loadSchedules();
    this.loadMacroDropdown();

    document.getElementById('btn-add-schedule')?.addEventListener('click', () => {
      this._resetScheduleForm();
      document.getElementById('schedule-form')?.classList.remove('hidden');
    });
    document.getElementById('btn-sched-cancel')?.addEventListener('click', () => {
      this._resetScheduleForm();
      document.getElementById('schedule-form')?.classList.add('hidden');
    });
    document.getElementById('btn-sched-save')?.addEventListener('click', () => this.saveSchedule());

    // ── Logs tab ───────────────────────────────────────────────────
    document.getElementById('btn-load-audit')?.addEventListener('click', () => this.loadAuditLog());
    document.getElementById('audit-filter')?.addEventListener('change', () => this.filterAuditLog());
    document.getElementById('audit-actor-filter')?.addEventListener('change', () => this.filterAuditLog());
    document.getElementById('audit-search')?.addEventListener('input', () => this.filterAuditLog());

    // ── Config tab ────────────────────────────────────────────────
    this._loadConfigEditor();
    document.getElementById('btn-config-save')?.addEventListener('click', () => this._saveConfig());
    document.getElementById('btn-gateway-restart')?.addEventListener('click', () => this._restartGateway());

    // Entity find & replace panel
    document.getElementById('btn-open-entity-fr')?.addEventListener('click', () => this._openEntityFRPanel());

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
          headers: { 'Content-Type': 'application/json' },
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

  _switchSearchTerm: '',

  async _openSwitchPanel(title, prefix) {
    const self = this;
    const tabletId = localStorage.getItem('tabletId') || 'WebApp';
    self._switchSearchTerm = '';

    App.showPanel(title, async (body) => {
      body.innerHTML = '<div class="text-center" style="padding:30px;opacity:0.5;">Loading switches...</div>';

      let allEntities = [];

      const fetchEntities = async () => {
        const resp = await fetch(`/api/ha/entities?domain=switch&q=${prefix}`, {

        });
        const data = await resp.json();
        if (data.error) throw new Error(data.error);

        const entities = [];
        const prefixLower = prefix.toLowerCase();
        for (const [, info] of Object.entries(data.domains || {})) {
          for (const ent of (info.entities || [])) {
            const eid = ent.entity_id.toLowerCase();
            const fname = (ent.friendly_name || '').toLowerCase();
            if (eid.includes(prefixLower) || fname.includes(prefixLower)) {
              entities.push(ent);
            }
          }
        }
        entities.sort((a, b) => (a.friendly_name || a.entity_id).localeCompare(b.friendly_name || b.entity_id));
        return entities;
      };

      const renderList = () => {
        const search = self._switchSearchTerm.toLowerCase();
        const filtered = search
          ? allEntities.filter(e => {
              const raw = e.friendly_name || e.entity_id.split('.').pop() || e.entity_id;
              const name = raw.replace(/^SW[_ ]|^WB[_ ]/i, '').replace(/_/g, ' ');
              return name.toLowerCase().includes(search) || e.entity_id.toLowerCase().includes(search);
            })
          : allEntities;

        const gridEl = body.querySelector('.switch-panel-grid');
        const countEl = body.querySelector('.switch-count');
        if (!gridEl) return;

        if (countEl) countEl.textContent = `${filtered.length} of ${allEntities.length} switches`;

        if (filtered.length === 0) {
          gridEl.innerHTML = `<div style="opacity:0.5;padding:20px;text-align:center;grid-column:1/-1;">No matches found.</div>`;
          return;
        }

        gridEl.innerHTML = filtered.map(e => {
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
        }).join('');

        // Wire toggle handlers
        gridEl.querySelectorAll('[data-switch-entity]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const entityId = btn.dataset.switchEntity;
            btn.disabled = true;
            try {
              await fetch(`/api/ha/service/switch/toggle`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entity_id: entityId }),
              });
              setTimeout(() => renderSwitches(), 800);
            } catch (err) {
              App.showToast('Failed to toggle switch');
              btn.disabled = false;
            }
          });
        });
      };

      const renderSwitches = async () => {
        try {
          allEntities = await fetchEntities();

          if (allEntities.length === 0) {
            body.innerHTML = `<div style="opacity:0.5;padding:20px;text-align:center;">No ${title} switches found.</div>`;
            return;
          }

          // Only rebuild the full layout on first render
          if (!body.querySelector('.switch-search-input')) {
            body.innerHTML = `
              <div class="switch-search-bar">
                <span class="material-icons" style="opacity:0.5;">search</span>
                <input type="text" class="switch-search-input" placeholder="Filter switches..." value="${self._switchSearchTerm}">
                <span class="switch-count" style="font-size:12px;opacity:0.5;white-space:nowrap;">${allEntities.length} of ${allEntities.length} switches</span>
              </div>
              <div class="switch-panel-grid"></div>
            `;
            body.querySelector('.switch-search-input')?.addEventListener('input', (e) => {
              self._switchSearchTerm = e.target.value;
              renderList();
            });
          }

          renderList();

        } catch (err) {
          body.innerHTML = `<div style="color:var(--danger);padding:16px;">Failed to load switches. ${err.message || 'Is Home Assistant connected?'}</div>`;
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
                  headers: { 'Content-Type': 'application/json' },
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
  // Power Tab — Break-Glass Direct WattBox Control
  // =====================================================================

  async _loadBreakGlassDevices() {
    const grid = document.getElementById('breakglass-devices');
    if (!grid) return;
    const tabletId = localStorage.getItem('tabletId') || 'WebApp';

    try {
      const resp = await fetch('/api/wattbox/devices', {

      });
      const devices = await resp.json();
      if (devices.error) {
        grid.innerHTML = `<div style="opacity:0.5;font-size:13px;">${devices.error}</div>`;
        return;
      }

      grid.innerHTML = Object.entries(devices).map(([key, dev]) => {
        const stateClass = dev.state === 'on' ? 'idle' : dev.state === 'off' ? 'offline' : '';
        return `<div class="control-section" style="margin:0;padding:12px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <span class="status-dot ${stateClass}"></span>
            <strong style="font-size:14px;">${dev.label}</strong>
            <span style="font-size:11px;opacity:0.5;">${dev.ip}:${dev.outlet}</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-sm" data-bg-key="${key}" data-bg-action="cycle" style="flex:1;">
              <span class="material-icons" style="font-size:16px;">restart_alt</span>
              <span class="btn-label">Reboot</span>
            </button>
            <button class="btn btn-sm" data-bg-key="${key}" data-bg-action="off" style="flex:1;">
              <span class="material-icons" style="font-size:16px;">power_off</span>
              <span class="btn-label">Off</span>
            </button>
            <button class="btn btn-sm" data-bg-key="${key}" data-bg-action="on" style="flex:1;">
              <span class="material-icons" style="font-size:16px;">power</span>
              <span class="btn-label">On</span>
            </button>
          </div>
        </div>`;
      }).join('');

      // Wire handlers
      grid.querySelectorAll('[data-bg-key]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.bgKey;
          const action = btn.dataset.bgAction;
          const label = devices[key]?.label || key;

          const confirmed = await App.showConfirm(
            `<strong style="color:var(--danger);">Break-Glass Action</strong><br><br>` +
            `${action === 'cycle' ? 'Reboot' : action === 'off' ? 'Power OFF' : 'Power ON'} ` +
            `<strong>${label}</strong>?<br><br>` +
            `<span style="font-size:13px;opacity:0.7;">This bypasses Home Assistant and controls the WattBox outlet directly.</span>`
          );
          if (!confirmed) return;

          btn.disabled = true;
          btn.classList.add('loading');
          try {
            const resp = await fetch(`/api/wattbox/${key}/power`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action }),
            });
            const result = await resp.json();
            if (result.success) {
              App.showToast(`${label}: ${action === 'cycle' ? 'Rebooting' : action === 'off' ? 'Powered off' : 'Powered on'}`);
              // Refresh device states after a short delay
              setTimeout(() => this._loadBreakGlassDevices(), 2000);
            } else {
              App.showToast(result.error || 'Command failed', 3000, 'error');
            }
          } catch (err) {
            App.showToast('Failed to reach WattBox', 3000, 'error');
          } finally {
            btn.disabled = false;
            btn.classList.remove('loading');
          }
        });
      });

    } catch (err) {
      grid.innerHTML = '<div style="color:var(--danger);font-size:13px;">Failed to load WattBox devices.</div>';
    }
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
            headers: { 'Content-Type': 'application/json' },
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, hvac_mode: newMode }),
          });
        } catch (e) { console.error('set_hvac_mode error:', e); }
      });
    });

    // Poll for live updates
    const pollTimer = setInterval(async () => {
      if (!body.isConnected) { clearInterval(pollTimer); return; }
      try {
        const r = await fetch(`/api/ha/states/${entityId}`, {});
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
  // TV's Tab — TV & Projector Controls
  // =====================================================================

  // TV definitions grouped by room/section
  // Each TV specifies: label, receiver id, brand (samsung|vizio|rca|epson)
  _tvRooms: [
    {
      room: 'Main Church',
      icon: 'church',
      devices: [
        { label: 'Front Left Projector',  type: 'epson', key: 'epson1' },
        { label: 'Front Right Projector', type: 'epson', key: 'epson2' },
        { label: 'Rear Left Projector',   type: 'epson', key: 'epson3' },
        { label: 'Rear Right Projector',  type: 'epson', key: 'epson4' },
        { label: 'Portable TV',           type: 'vizio', rx: 34 },
        { label: 'Cry Room',              type: 'samsung', rx: 35 },
      ]
    },
    {
      room: 'Social Hall',
      icon: 'grid_view',
      devices: [
        { label: 'Video Wall Left P1',  type: 'samsung', rx: 1 },
        { label: 'Video Wall Left P2',  type: 'samsung', rx: 2 },
        { label: 'Video Wall Left P3',  type: 'samsung', rx: 3 },
        { label: 'Video Wall Left P4',  type: 'samsung', rx: 4 },
        { label: 'Video Wall Right P1', type: 'samsung', rx: 5 },
        { label: 'Video Wall Right P2', type: 'samsung', rx: 6 },
        { label: 'Video Wall Right P3', type: 'samsung', rx: 7 },
        { label: 'Video Wall Right P4', type: 'samsung', rx: 8 },
      ]
    },
    {
      room: 'Chapel',
      icon: 'meeting_room',
      devices: [
        { label: 'Portable TV (Vizio)', type: 'vizio', rx: 9 },
        { label: 'Floating TV (RCA)',   type: 'rca', rx: 9 },
      ]
    },
    {
      room: 'Conference Room',
      icon: 'groups',
      devices: [
        { label: 'Left TV',  type: 'samsung', rx: 28 },
        { label: 'Right TV', type: 'samsung', rx: 29 },
      ]
    },
    {
      room: 'Sunday School',
      icon: 'school',
      devices: [
        { label: 'Angels I (PreK)',     type: 'samsung', rx: 13 },
        { label: 'Angels II (Kinder)',  type: 'samsung', rx: 14 },
        { label: '1st & 2nd Grade',     type: 'samsung', rx: 15 },
        { label: '3rd & 4th Grade',     type: 'samsung', rx: 16 },
        { label: '5th & 6th Grade',     type: 'samsung', rx: 17 },
        { label: '7th & 8th Grade',     type: 'samsung', rx: 30 },
        { label: 'High School',         type: 'samsung', rx: 21 },
        { label: 'Open Room',           type: 'samsung', rx: 33 },
        { label: 'Fr. Andrew Office',   type: 'samsung', rx: 18 },
        { label: 'Fr. Kyrillos Office', type: 'samsung', rx: 20 },
        { label: 'Old P5',              type: 'samsung', rx: 23 },
      ]
    },
    {
      room: 'Other',
      icon: 'tv',
      devices: [
        { label: 'Lounge',     type: 'samsung', rx: 26 },
        { label: 'Hamal Room', type: 'samsung', rx: 27 },
      ]
    },
  ],

  _loadTVControls() {
    const grid = document.getElementById('tv-controls-grid');
    if (!grid) return;

    const tabletId = localStorage.getItem('tabletId') || 'WebApp';

    // IR code mappings per brand
    const irCodes = {
      samsung: { on: 'IRPowerOn', off: 'IRPowerOff', hdmi1: 'IRSourceHDMI1', hdmi2: 'IRSourceHDMI2' },
      vizio:   { on: 'IRPowerOnVizio', off: 'IRPowerOffVizio', hdmi1: 'IRSourceHDMI1Vizio', hdmi2: 'IRSourceHDMI2Vizio' },
      rca:     { on: 'IRPowerOnRCA', off: 'IRPowerOffRCA' },
    };

    let html = '';

    this._tvRooms.forEach(room => {
      html += `<div class="control-section">
        <div class="section-title"><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">${room.icon}</span>${room.room}</div>
        <div class="tv-controls-grid">`;

      room.devices.forEach(dev => {
        const isEpson = dev.type === 'epson';
        const codes = irCodes[dev.type];
        const hasHdmi = codes && codes.hdmi1;

        html += `<div class="tv-control-card">
          <div class="tv-control-label">
            <span class="material-icons" style="font-size:16px;opacity:0.5;">${isEpson ? 'videocam' : 'tv'}</span>
            <span>${dev.label}</span>
          </div>
          <div class="tv-control-buttons">
            <button class="btn btn-sm tv-btn tv-btn-on" data-tv-action="on" data-tv-type="${dev.type}" ${isEpson ? `data-epson-key="${dev.key}"` : `data-rx="${dev.rx}" data-ir-code="${codes.on}"`} title="Power On">
              <span class="material-icons">power_settings_new</span>
            </button>
            <button class="btn btn-sm tv-btn tv-btn-off" data-tv-action="off" data-tv-type="${dev.type}" ${isEpson ? `data-epson-key="${dev.key}"` : `data-rx="${dev.rx}" data-ir-code="${codes.off}"`} title="Power Off">
              <span class="material-icons">power_off</span>
            </button>`;

        if (hasHdmi) {
          html += `
            <button class="btn btn-sm tv-btn tv-btn-src" data-tv-action="hdmi1" data-tv-type="${dev.type}" data-rx="${dev.rx}" data-ir-code="${codes.hdmi1}" title="HDMI 1">
              <span>H1</span>
            </button>
            <button class="btn btn-sm tv-btn tv-btn-src" data-tv-action="hdmi2" data-tv-type="${dev.type}" data-rx="${dev.rx}" data-ir-code="${codes.hdmi2}" title="HDMI 2">
              <span>H2</span>
            </button>`;
        }

        html += `</div></div>`;
      });

      html += '</div></div>';
    });

    // Add "All Projectors" quick actions at the top
    const projectorActions = `<div class="control-section">
      <div class="section-title"><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">settings_remote</span>Quick Actions</div>
      <div class="tv-quick-actions">
        <button class="btn tv-btn-quick" id="tv-all-projectors-on" title="Turn on all 4 Main Church projectors">
          <span class="material-icons">videocam</span>
          <span class="btn-label">All Projectors On</span>
        </button>
        <button class="btn tv-btn-quick" id="tv-all-projectors-off" title="Turn off all 4 Main Church projectors">
          <span class="material-icons">videocam_off</span>
          <span class="btn-label">All Projectors Off</span>
        </button>
      </div>
    </div>`;

    grid.innerHTML = projectorActions + html;

    // Wire all TV control buttons
    grid.querySelectorAll('.tv-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.tvType;
        const action = btn.dataset.tvAction;

        btn.classList.add('loading');
        btn.disabled = true;

        try {
          if (type === 'epson') {
            const key = btn.dataset.epsonKey;
            if (action === 'on') {
              await EpsonAPI.powerOn(key);
            } else {
              await EpsonAPI.powerOff(key);
            }
            App.showToast(`${btn.closest('.tv-control-card').querySelector('.tv-control-label span:last-child').textContent}: ${action === 'on' ? 'Powering on' : 'Powering off'}`);
          } else {
            const rx = btn.dataset.rx;
            const code = btn.dataset.irCode;
            await MoIPAPI.sendIR('0', rx, code);
            App.showToast(`${btn.closest('.tv-control-card').querySelector('.tv-control-label span:last-child').textContent}: ${action.toUpperCase()}`);
          }
        } catch (e) {
          App.showToast('Command failed', 3000, 'error');
        } finally {
          setTimeout(() => {
            btn.classList.remove('loading');
            btn.disabled = false;
          }, 1000);
        }
      });
    });

    // Wire quick action buttons
    document.getElementById('tv-all-projectors-on')?.addEventListener('click', async function() {
      this.classList.add('loading');
      this.disabled = true;
      try {
        await EpsonAPI.allOn();
        App.showToast('All projectors: Powering on');
      } catch (e) {
        App.showToast('Failed to power on projectors', 3000, 'error');
      } finally {
        setTimeout(() => { this.classList.remove('loading'); this.disabled = false; }, 2000);
      }
    });

    document.getElementById('tv-all-projectors-off')?.addEventListener('click', async function() {
      this.classList.add('loading');
      this.disabled = true;
      try {
        await EpsonAPI.allOff();
        App.showToast('All projectors: Powering off');
      } catch (e) {
        App.showToast('Failed to power off projectors', 3000, 'error');
      } finally {
        setTimeout(() => { this.classList.remove('loading'); this.disabled = false; }, 2000);
      }
    });
  },

  // =====================================================================
  // Existing methods (unchanged)
  // =====================================================================

  _auditData: [],

  async loadVerboseLogging() {
    try {
      const resp = await fetch('/api/settings/verbose-logging', {

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
      const tabletId = localStorage.getItem('tabletId') || 'WebApp';
      const limit = document.getElementById('audit-limit')?.value || '500';
      const [logsResp, sessionsResp, actorsResp] = await Promise.all([
        fetch(`/api/audit/logs?limit=${limit}`, {}),
        fetch('/api/audit/sessions', {}),
        fetch('/api/audit/actors', {}),
      ]);
      this._auditData = await logsResp.json();
      const sessions = await sessionsResp.json();
      const actorsData = await actorsResp.json();

      // Populate actor filter dropdown
      const actorSelect = document.getElementById('audit-actor-filter');
      if (actorSelect && actorsData.actors) {
        const current = actorSelect.value;
        actorSelect.innerHTML = '<option value="">All Users</option>' +
          actorsData.actors.map(a => `<option value="${this._escAttr(a)}"${a === current ? ' selected' : ''}>${this._escHtml(a)}</option>`).join('');
      }

      document.getElementById('audit-container')?.classList.remove('hidden');
      this.filterAuditLog();
      this.renderSessions(sessions);
    } catch (e) {
      App.showToast('Failed to load audit log');
    }
  },

  renderAuditLog(logs) {
    const container = document.getElementById('audit-log');
    const countEl = document.getElementById('audit-count');
    if (!container) return;

    const total = this._auditData ? this._auditData.length : logs.length;
    if (countEl) countEl.textContent = logs.length === total ? `${total} entries` : `${logs.length} of ${total} entries`;

    if (logs.length === 0) {
      container.innerHTML = '<div style="opacity:0.5;padding:8px;">No activity recorded yet.</div>';
      return;
    }

    container.innerHTML = logs.map((log, idx) => {
      let ts = '--';
      if (log.timestamp) {
        const raw = log.timestamp.endsWith('Z') ? log.timestamp : log.timestamp + 'Z';
        const d = new Date(raw);
        if (!isNaN(d.getTime())) {
          ts = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).replace(',', '');
        }
      }
      const tablet = (log.actor || log.tablet_id || '').replace('Tablet_', '');
      const latency = log.latency_ms ? `${Math.round(log.latency_ms)}ms` : '';
      const resultFull = log.result || '';
      const resultShort = resultFull.substring(0, 60);
      const isError = /FAIL|ERROR|TIMEOUT|CONNECTION_ERROR/i.test(resultFull);
      const rowClass = isError ? 'audit-row audit-row-error' : 'audit-row';
      const hasDetails = log.request_data || resultFull.length > 60;
      const expandIcon = hasDetails ? '<span class="material-icons audit-expand-icon" style="font-size:14px;cursor:pointer;opacity:0.4;margin-right:4px;">expand_more</span>' : '<span style="width:18px;display:inline-block;margin-right:4px;"></span>';

      let detailsHtml = '';
      if (hasDetails) {
        let reqDisplay = '';
        if (log.request_data) {
          try {
            reqDisplay = JSON.stringify(JSON.parse(log.request_data), null, 2);
          } catch { reqDisplay = log.request_data; }
        }
        detailsHtml = `<div class="audit-details" id="audit-detail-${idx}" style="display:none;">
          ${reqDisplay ? `<div><span style="color:#ff8c00;">Request:</span><pre style="margin:2px 0 4px 0;white-space:pre-wrap;word-break:break-all;color:#aaa;font-size:11px;">${this._escHtml(reqDisplay)}</pre></div>` : ''}
          ${resultFull.length > 60 ? `<div><span style="color:#ff8c00;">Full Result:</span><pre style="margin:2px 0 0 0;white-space:pre-wrap;word-break:break-all;color:#aaa;font-size:11px;">${this._escHtml(resultFull)}</pre></div>` : ''}
        </div>`;
      }

      return `<div class="${rowClass}" ${hasDetails ? `data-audit-detail="${idx}"` : ''}>
        ${expandIcon}
        <span class="audit-ts">${ts}</span>
        <span class="audit-tablet">${tablet}</span>
        <span class="audit-action">${log.action || ''}</span>
        <span class="audit-target">${log.target || ''}</span>
        <span class="audit-latency">${latency}</span>
        <span class="audit-result ${isError ? 'audit-result-error' : ''}">${resultShort}</span>
      </div>${detailsHtml}`;
    }).join('');

    // Wire up expandable row click handlers
    container.querySelectorAll('[data-audit-detail]').forEach(row => {
      row.addEventListener('click', () => {
        const idx = row.dataset.auditDetail;
        const detail = document.getElementById(`audit-detail-${idx}`);
        const icon = row.querySelector('.audit-expand-icon');
        if (detail) {
          const show = detail.style.display === 'none';
          detail.style.display = show ? 'block' : 'none';
          if (icon) icon.textContent = show ? 'expand_less' : 'expand_more';
        }
      });
    });
  },

  filterAuditLog() {
    const typeFilter = document.getElementById('audit-filter')?.value || '';
    const actorFilter = document.getElementById('audit-actor-filter')?.value || '';
    const searchTerm = (document.getElementById('audit-search')?.value || '').toLowerCase();

    let filtered = this._auditData;

    if (typeFilter === '__errors__') {
      filtered = filtered.filter(log => /FAIL|ERROR|TIMEOUT|CONNECTION_ERROR/i.test(log.result || ''));
    } else if (typeFilter) {
      filtered = filtered.filter(log => (log.action || '').startsWith(typeFilter));
    }
    if (actorFilter) {
      filtered = filtered.filter(log => (log.actor || '') === actorFilter);
    }
    if (searchTerm) {
      filtered = filtered.filter(log => {
        const searchable = `${log.action || ''} ${log.target || ''} ${log.actor || ''} ${log.tablet_id || ''} ${log.result || ''} ${log.request_data || ''}`.toLowerCase();
        return searchable.includes(searchTerm);
      });
    }

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

  // UI-only refresh — reads from cached API state without HTTP calls.
  // Called by Socket.IO state push (via App.refreshCurrentPage).
  updateStatus() {
    this._renderMixer(X32API.state);
  },

  async loadMixer() {
    const state = await X32API.poll();
    this._renderMixer(state);
  },

  _renderMixer(state) {
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
            <button class="channel-mute ${ch.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-ch="${ch.id}">
              ${ch.muted === 'muted' ? 'MUTED' : 'ON'}
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
        if (ch && ch.muted === 'muted') {
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
          <button class="channel-mute ${a.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-aux="${a.id}">
            ${a.muted === 'muted' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      auxContainer.querySelectorAll('[data-mute-aux]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const auxId = parseInt(btn.dataset.muteAux);
          const aux = state.auxChannels.find(a => a.id === auxId);
          if (aux && aux.muted === 'muted') {
            await X32API.unmuteAux(auxId);
          } else {
            await X32API.muteAux(auxId);
          }
          setTimeout(() => this.loadMixer(), 500);
        });
      });
    }

    // Mix Buses
    const busContainer = document.getElementById('bus-container');
    if (busContainer) {
      const activeBuses = state.buses.filter(b => b.name && b.name.trim() !== '');
      busContainer.innerHTML = activeBuses.map(b => `
        <div class="mixer-channel">
          <div class="channel-name" title="${b.name}">${b.name}</div>
          <div class="channel-volume">${Math.round(b.volume * 100)}%</div>
          <button class="channel-mute ${b.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-bus="${b.id}">
            ${b.muted === 'muted' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      busContainer.querySelectorAll('[data-mute-bus]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const busId = parseInt(btn.dataset.muteBus);
          const bus = state.buses.find(b => b.id === busId);
          if (bus && bus.muted === 'muted') {
            await X32API.unmuteBus(busId);
          } else {
            await X32API.muteBus(busId);
          }
          setTimeout(() => this.loadMixer(), 500);
        });
      });
    }

    // DCA Groups
    const dcaContainer = document.getElementById('dca-container');
    if (dcaContainer) {
      const activeDcas = state.dcas.filter(d => d.name && d.name.trim() !== '');
      dcaContainer.innerHTML = activeDcas.map(d => `
        <div class="mixer-channel">
          <div class="channel-name" title="${d.name}">${d.name}</div>
          <div class="channel-volume">${Math.round(d.volume * 100)}%</div>
          <button class="channel-mute ${d.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-dca="${d.id}">
            ${d.muted === 'muted' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      dcaContainer.querySelectorAll('[data-mute-dca]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const dcaId = parseInt(btn.dataset.muteDca);
          const dca = state.dcas.find(d => d.id === dcaId);
          if (dca && dca.muted === 'muted') {
            await X32API.unmuteDca(dcaId);
          } else {
            await X32API.muteDca(dcaId);
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
        if (ch.name && ch.name.trim() !== '' && ch.muted !== 'muted') {
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
        if (ch.name && ch.name.trim() !== '' && ch.muted === 'muted') {
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
      const anyUnmuted = musicChs.some(ch => ch.muted !== 'muted');
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
          <button class="btn" data-run-sched="${s.id}" data-run-macro="${s.macro_key}" data-run-name="${s.name}"
            style="min-height:auto;padding:6px 10px;font-size:11px;background:#1565c0;border-color:#1565c0;" title="Run Now">
            <span class="material-icons" style="font-size:16px;">play_circle</span>
          </button>
          <button class="btn" data-edit-sched="${s.id}" data-sched-name="${s.name}" data-sched-macro="${s.macro_key}" data-sched-time="${s.time_of_day}" data-sched-days="${s.days}"
            style="min-height:auto;padding:6px 10px;font-size:11px;" title="Edit">
            <span class="material-icons" style="font-size:16px;">edit</span>
          </button>
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !currentlyEnabled }),
        });
        this.loadSchedules();
      });
    });

    // Run Now
    container.querySelectorAll('[data-run-sched]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const macroKey = btn.dataset.runMacro;
        const name = btn.dataset.runName;
        btn.disabled = true;
        btn.querySelector('.material-icons').textContent = 'hourglass_empty';
        try {
          const resp = await fetch('/api/macro/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ macro: macroKey }),
          });
          const result = await resp.json();
          if (result.success) {
            App.showToast(`${name}: started`, 3000);
          } else {
            App.showToast(`${name}: ${result.error || 'failed'}`, 4000, 'error');
          }
        } catch (e) {
          App.showToast(`${name}: network error`, 4000, 'error');
        } finally {
          btn.disabled = false;
          btn.querySelector('.material-icons').textContent = 'play_circle';
        }
      });
    });

    // Delete
    container.querySelectorAll('[data-delete-sched]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteSched;
        if (!await App.showConfirm('Delete this scheduled automation?')) return;
        await fetch(`/api/schedule/${id}`, {
          method: 'DELETE',

        });
        this.loadSchedules();
      });
    });

    // Edit
    container.querySelectorAll('[data-edit-sched]').forEach(btn => {
      btn.addEventListener('click', () => {
        this._editScheduleId = btn.dataset.editSched;
        document.getElementById('sched-name').value = btn.dataset.schedName || '';
        const macroSelect = document.getElementById('sched-macro');
        if (macroSelect) {
          macroSelect.value = btn.dataset.schedMacro || '';
          this._showMacroDetails(macroSelect.value);
        }
        document.getElementById('sched-time').value = btn.dataset.schedTime || '08:00';
        const activeDays = (btn.dataset.schedDays || '').split(',');
        document.querySelectorAll('#sched-days input[type="checkbox"]').forEach(cb => {
          cb.checked = activeDays.includes(cb.value);
        });
        document.getElementById('schedule-form')?.classList.remove('hidden');
        document.getElementById('btn-sched-save').querySelector('.btn-label').textContent = 'Update';
      });
    });
  },

  _macroMeta: {},

  async loadMacroDropdown() {
    const select = document.getElementById('sched-macro');
    if (!select) return;
    try {
      const resp = await fetch('/api/macros', {

      });
      const data = await resp.json();
      const macros = data.macros || {};
      this._macroMeta = macros;
      select.innerHTML = Object.entries(macros).map(([key, m]) =>
        `<option value="${key}">${m.label || key}</option>`
      ).join('');
    } catch (e) {
      select.innerHTML = '<option value="">Failed to load macros</option>';
    }

    // Show macro details when selection changes
    select.addEventListener('change', () => this._showMacroDetails(select.value));
    // Show details for the initially selected macro
    if (select.value) this._showMacroDetails(select.value);
  },

  async _showMacroDetails(macroKey) {
    const panel = document.getElementById('sched-macro-details');
    const descEl = document.getElementById('sched-macro-desc');
    const stepsEl = document.getElementById('sched-macro-steps');
    if (!panel || !macroKey) {
      panel?.classList.add('hidden');
      return;
    }

    const meta = this._macroMeta[macroKey];
    const desc = meta?.description;
    descEl.textContent = desc || '';
    descEl.style.display = desc ? '' : 'none';
    stepsEl.innerHTML = '<span style="opacity:0.5;">Loading...</span>';
    panel.classList.remove('hidden');

    try {
      const resp = await fetch(`/api/macro/expand/${encodeURIComponent(macroKey)}`, {

        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      stepsEl.innerHTML = this._renderStepTree(data.steps || [], 0);
    } catch {
      stepsEl.innerHTML = '<span style="color:#cc0000;">Failed to load steps</span>';
    }
  },

  _renderStepTree(steps, depth) {
    if (!steps.length) return '<em>No steps</em>';
    const indent = depth * 16;
    return steps.map(s => {
      const icon = this._stepIcon(s.type);
      let html = `<div style="padding-left:${indent}px;">${icon} ${this._escHtml(s.label || s.type)}</div>`;
      if (s.children?.length) {
        html += `<div style="padding-left:${indent + 16}px;border-left:1px solid #333;margin-left:${indent + 6}px;">`;
        html += this._renderStepTree(s.children, depth + 1);
        html += '</div>';
      }
      return html;
    }).join('');
  },

  _stepIcon(type) {
    const icons = {
      ha_service: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#4fc3f7;">smart_home</span>',
      ha_check: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#81c784;">check_circle</span>',
      moip_switch: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#ce93d8;">settings_input_hdmi</span>',
      moip_ir: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#ce93d8;">settings_remote</span>',
      obs_emit: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#ef5350;">videocam</span>',
      x32_scene: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#ffb74d;">equalizer</span>',
      delay: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#666;">hourglass_empty</span>',
      macro: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#ff8c00;">play_circle</span>',
      condition: '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#aed581;">call_split</span>',
    };
    return icons[type] || '<span class="material-icons" style="font-size:11px;vertical-align:middle;color:#888;">circle</span>';
  },

  _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
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

    const editId = this._editScheduleId;

    try {
      if (editId) {
        await fetch(`/api/schedule/${editId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, macro, time, days }),
        });
        App.showToast('Schedule updated');
      } else {
        await fetch('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, macro, time, days }),
        });
        App.showToast('Schedule created');
      }
      this._resetScheduleForm();
      document.getElementById('schedule-form')?.classList.add('hidden');
      this.loadSchedules();
    } catch (e) {
      App.showToast(editId ? 'Failed to update schedule' : 'Failed to create schedule', 3000, 'error');
    }
  },

  _resetScheduleForm() {
    this._editScheduleId = null;
    const nameInput = document.getElementById('sched-name');
    if (nameInput) nameInput.value = '';
    const timeInput = document.getElementById('sched-time');
    if (timeInput) timeInput.value = '08:00';
    document.querySelectorAll('#sched-days input[type="checkbox"]').forEach(cb => { cb.checked = true; });
    const saveBtn = document.getElementById('btn-sched-save');
    if (saveBtn) {
      const label = saveBtn.querySelector('.btn-label');
      if (label) label.textContent = 'Save';
    }
    document.getElementById('sched-macro-details')?.classList.add('hidden');
  },

  // -----------------------------------------------------------------------
  // Health Dashboard Panel
  // -----------------------------------------------------------------------

  openHealthPanel() {
    App.openHealthDashPanel();
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

  // =========================================================================
  // CONFIG EDITOR
  // =========================================================================

  _configData: null,

  async _loadConfigEditor() {
    const grid = document.getElementById('config-editor-grid');
    if (!grid) return;
    try {
      const resp = await fetch('/api/config/editable', {signal: AbortSignal.timeout(5000)});
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._configData = await resp.json();
      this._renderConfigSections(grid);
    } catch (e) {
      grid.innerHTML = `<div class="control-section" style="grid-column:1/-1;">
        <div class="info-text" style="color:var(--danger);">Failed to load config: ${e.message}</div>
      </div>`;
    }
  },

  _renderConfigSections(grid) {
    const data = this._configData;
    if (!data) return;

    const sectionMeta = {
      gateway:    {title: 'Gateway',       icon: 'dns'},
      obs:        {title: 'OBS Studio',    icon: 'videocam'},
      moip:       {title: 'MoIP Controller', icon: 'settings_input_hdmi'},
      x32:        {title: 'X32 Mixer',     icon: 'equalizer'},
      ptz_cameras:{title: 'PTZ Cameras',   icon: 'videocam'},
      projectors: {title: 'Projectors',    icon: 'tv'},
      camlytics:  {title: 'Camlytics',     icon: 'analytics'},
      security:   {title: 'Security',      icon: 'security'},
      fully_kiosk:{title: 'Fully Kiosk',   icon: 'tablet'},
    };

    const fieldLabels = {
      host: 'Host', port: 'Port', debug: 'Debug',
      ws_url: 'WebSocket URL', ping_seconds: 'Ping Interval (s)',
      snapshot_seconds: 'Snapshot Interval (s)', offline_after_seconds: 'Offline After (s)',
      ping_fails_to_offline: 'Ping Fails to Offline', max_scenes: 'Max Scenes',
      host_internal: 'Internal Host', port_internal: 'Internal Port',
      host_external: 'External Host', port_external: 'External Port',
      mixer_ip: 'Mixer IP', mixer_type: 'Mixer Type',
      communion_url: 'Communion URL', communion_buffer_default: 'Communion Buffer %',
      occupancy_url_peak: 'Occupancy Peak URL', occupancy_url_live: 'Occupancy Live URL',
      occupancy_buffer_default: 'Occupancy Buffer %',
      allowed_ips: 'Allowed IPs', session_timeout_minutes: 'Session Timeout (min)',
      devices: 'Devices',
    };

    let html = '';
    for (const [section, info] of Object.entries(data)) {
      const meta = sectionMeta[section] || {title: section, icon: 'settings'};
      const envFlags = info._env || {};
      const value = info._value || {};

      if (info._fields === '*') {
        // Dict editor (cameras, projectors)
        html += this._renderDictSection(section, meta, value, envFlags);
      } else {
        // Field list editor
        html += `<div class="control-section" style="grid-column:1/-1;">
          <div class="section-title"><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">${meta.icon}</span>${meta.title}</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(250px, 1fr));gap:8px;">`;

        for (const [field, val] of Object.entries(value)) {
          const label = fieldLabels[field] || field;
          const isEnv = envFlags[field];
          const envBadge = isEnv ? ' <span style="font-size:10px;background:#ff9800;color:#000;padding:1px 5px;border-radius:3px;margin-left:4px;">from .env</span>' : '';
          const disabled = isEnv ? 'disabled' : '';

          if (field === 'allowed_ips' && Array.isArray(val)) {
            html += `<div style="grid-column:1/-1;">
              <label style="font-size:11px;opacity:0.7;">${label}${envBadge}</label>
              <textarea id="cfg-${section}-${field}" rows="3" ${disabled}
                style="width:100%;padding:6px;border-radius:4px;border:1px solid #444;background:${isEnv ? '#333' : '#222'};color:#fff;font-size:13px;font-family:inherit;resize:vertical;"
              >${(val || []).join('\n')}</textarea>
            </div>`;
          } else if (typeof val === 'boolean') {
            html += `<div>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
                <input type="checkbox" id="cfg-${section}-${field}" ${val ? 'checked' : ''} ${disabled}
                  style="width:18px;height:18px;">
                <span>${label}${envBadge}</span>
              </label>
            </div>`;
          } else if (typeof val === 'number') {
            html += `<div>
              <label style="font-size:11px;opacity:0.7;">${label}${envBadge}</label>
              <input type="number" id="cfg-${section}-${field}" value="${val}" ${disabled} step="any"
                style="width:100%;padding:6px;border-radius:4px;border:1px solid #444;background:${isEnv ? '#333' : '#222'};color:#fff;font-size:13px;font-family:inherit;">
            </div>`;
          } else {
            html += `<div>
              <label style="font-size:11px;opacity:0.7;">${label}${envBadge}</label>
              <input type="text" id="cfg-${section}-${field}" value="${val || ''}" ${disabled}
                style="width:100%;padding:6px;border-radius:4px;border:1px solid #444;background:${isEnv ? '#333' : '#222'};color:#fff;font-size:13px;font-family:inherit;">
            </div>`;
          }
        }
        html += '</div></div>';
      }
    }
    grid.innerHTML = html;
  },

  _renderDictSection(section, meta, value, envFlags) {
    const items = Object.entries(value);
    let rows = '';
    for (const [key, obj] of items) {
      const ip = typeof obj === 'object' ? (obj.ip || '') : obj;
      const name = typeof obj === 'object' ? (obj.name || '') : '';
      rows += `<tr data-cfg-dict-row="${section}">
        <td><input type="text" value="${key}" data-field="key" style="width:100%;padding:4px;border-radius:3px;border:1px solid #444;background:#222;color:#fff;font-size:12px;font-family:inherit;"></td>
        <td><input type="text" value="${ip}" data-field="ip" style="width:100%;padding:4px;border-radius:3px;border:1px solid #444;background:#222;color:#fff;font-size:12px;font-family:inherit;"></td>
        <td><input type="text" value="${name}" data-field="name" style="width:100%;padding:4px;border-radius:3px;border:1px solid #444;background:#222;color:#fff;font-size:12px;font-family:inherit;"></td>
        <td style="text-align:center;"><button class="btn" style="padding:2px 6px;min-width:0;" onclick="this.closest('tr').remove()"><span class="material-icons" style="font-size:16px;">delete</span></button></td>
      </tr>`;
    }
    return `<div class="control-section" style="grid-column:1/-1;">
      <div class="section-title"><span class="material-icons" style="font-size:18px;vertical-align:text-bottom;margin-right:4px;">${meta.icon}</span>${meta.title}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;" id="cfg-table-${section}">
        <thead><tr style="opacity:0.7;font-size:11px;text-align:left;">
          <th style="padding:4px;">Name</th><th style="padding:4px;">IP</th><th style="padding:4px;">Display Name</th><th style="width:40px;"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <button class="btn" style="margin-top:6px;display:inline-flex;padding:4px 10px;" onclick="SettingsPage._addDictRow('${section}')">
        <span class="material-icons" style="font-size:16px;">add</span>
        <span class="btn-label" style="font-size:12px;">Add</span>
      </button>
    </div>`;
  },

  _addDictRow(section) {
    const table = document.getElementById(`cfg-table-${section}`);
    if (!table) return;
    const tbody = table.querySelector('tbody');
    const tr = document.createElement('tr');
    tr.setAttribute('data-cfg-dict-row', section);
    tr.innerHTML = `
      <td><input type="text" value="" data-field="key" style="width:100%;padding:4px;border-radius:3px;border:1px solid #444;background:#222;color:#fff;font-size:12px;font-family:inherit;"></td>
      <td><input type="text" value="" data-field="ip" style="width:100%;padding:4px;border-radius:3px;border:1px solid #444;background:#222;color:#fff;font-size:12px;font-family:inherit;"></td>
      <td><input type="text" value="" data-field="name" style="width:100%;padding:4px;border-radius:3px;border:1px solid #444;background:#222;color:#fff;font-size:12px;font-family:inherit;"></td>
      <td style="text-align:center;"><button class="btn" style="padding:2px 6px;min-width:0;" onclick="this.closest('tr').remove()"><span class="material-icons" style="font-size:16px;">delete</span></button></td>
    `;
    tbody.appendChild(tr);
  },

  _collectConfigValues() {
    const data = this._configData;
    if (!data) return null;
    const result = {};

    for (const [section, info] of Object.entries(data)) {
      const envFlags = info._env || {};

      if (info._fields === '*') {
        // Collect dict from table rows
        const rows = document.querySelectorAll(`tr[data-cfg-dict-row="${section}"]`);
        const dict = {};
        rows.forEach(row => {
          const key = row.querySelector('[data-field="key"]')?.value?.trim();
          const ip = row.querySelector('[data-field="ip"]')?.value?.trim();
          const name = row.querySelector('[data-field="name"]')?.value?.trim();
          if (key) {
            dict[key] = {ip: ip || '', name: name || ''};
          }
        });
        result[section] = dict;
      } else {
        const fields = info._fields || [];
        const sectionData = {};
        for (const field of fields) {
          if (envFlags[field]) continue; // skip env-overridden
          const el = document.getElementById(`cfg-${section}-${field}`);
          if (!el) continue;

          if (field === 'allowed_ips') {
            sectionData[field] = el.value.split('\n').map(s => s.trim()).filter(Boolean);
          } else if (el.type === 'checkbox') {
            sectionData[field] = el.checked;
          } else if (el.type === 'number') {
            const num = parseFloat(el.value);
            sectionData[field] = isNaN(num) ? el.value : num;
          } else {
            sectionData[field] = el.value;
          }
        }
        result[section] = sectionData;
      }
    }
    return result;
  },

  async _saveConfig() {
    const values = this._collectConfigValues();
    if (!values) { App.showToast('No config loaded', 3000, 'error'); return; }

    const btn = document.getElementById('btn-config-save');
    if (btn) { btn.disabled = true; btn.querySelector('.btn-label').textContent = 'Saving...'; }

    try {
      const resp = await fetch('/api/config/save', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(values),
        signal: AbortSignal.timeout(10000),
      });
      const result = await resp.json();
      if (result.success) {
        const msg = result.changes?.length
          ? `Saved ${result.changes.length} change(s). Restart gateway to apply.`
          : result.message || 'No changes detected.';
        App.showToast(msg, 4000);
      } else {
        App.showToast(result.error || 'Save failed', 4000, 'error');
      }
    } catch (e) {
      App.showToast(`Save failed: ${e.message}`, 4000, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.querySelector('.btn-label').textContent = 'Save Config'; }
    }
  },

  async _restartGateway() {
    if (!confirm('Restart the gateway? All tablets will briefly disconnect.')) return;

    try {
      await fetch('/api/gateway/restart', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      // Expected — server dies before response completes
    }
  },

  // ── Entity Find & Replace Panel ─────────────────────────────────

  _frMacroSwitches: [],  // All switch entities in macros.yaml
  _frHaSwitches: [],     // All switch entities from HA
  _frSelectedFind: null,
  _frSelectedReplace: null,
  _frPairs: [],          // [{old, new}]

  async _openEntityFRPanel() {
    this._frSelectedFind = null;
    this._frSelectedReplace = null;
    this._frPairs = [];

    App.showPanel('Entity Find & Replace', async (body) => {
      body.innerHTML = '<div style="text-align:center;padding:40px;opacity:0.5;">Loading entity data...</div>';

      // Fetch both data sources in parallel
      try {
        const [macroResp, haResp] = await Promise.all([
          fetch('/api/entities/switches', {signal: AbortSignal.timeout(5000)}),
          fetch('/api/ha/entities?domain=switch', {signal: AbortSignal.timeout(10000)}),
        ]);
        const macroData = await macroResp.json();
        const haData = await haResp.json();

        this._frMacroSwitches = (macroData.switches || []).map(id => ({
          entity_id: id,
          label: id.replace('switch.', ''),
        }));
        const haEntities = (haData.domains?.switch?.entities || []);
        this._frHaSwitches = haEntities.map(e => ({
          entity_id: e.entity_id,
          label: e.entity_id.replace('switch.', ''),
          friendly_name: e.friendly_name || '',
        }));
      } catch (e) {
        body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--danger);">
          Failed to load entity data: ${e.message}</div>`;
        return;
      }

      body.innerHTML = this._frRenderPanel();
      this._frBindEvents(body);
    });
  },

  _frRenderPanel() {
    return `
      <div class="efr-panel">
        <div class="efr-columns">
          <div class="efr-col">
            <div class="efr-col-title">Find (in macros.yaml)</div>
            <div class="efr-search-row">
              <span class="efr-prefix">switch.</span>
              <input type="text" class="text-input efr-input" id="efr-find-input" placeholder="Start typing... e.g. SW_" autocomplete="off">
            </div>
            <div class="efr-selected" id="efr-find-selected"></div>
            <div class="efr-results" id="efr-find-results"></div>
          </div>
          <div class="efr-col">
            <div class="efr-col-title">Replace with (from Home Assistant)</div>
            <div class="efr-search-row">
              <span class="efr-prefix">switch.</span>
              <input type="text" class="text-input efr-input" id="efr-replace-input" placeholder="Start typing... e.g. SW_" autocomplete="off">
            </div>
            <div class="efr-selected" id="efr-replace-selected"></div>
            <div class="efr-results" id="efr-replace-results"></div>
          </div>
        </div>
        <div class="efr-add-row">
          <button class="btn" id="efr-add-btn" disabled>
            <span class="material-icons">add</span>
            <span class="btn-label">Add to List</span>
          </button>
        </div>
        <div class="efr-pairs-section">
          <div class="efr-pairs-title">Replacement Queue</div>
          <div class="efr-pairs-list" id="efr-pairs-list">
            <div class="efr-pairs-empty">No replacements queued</div>
          </div>
          <div class="efr-actions">
            <button class="btn" id="efr-replace-all-btn" disabled>
              <span class="material-icons">find_replace</span>
              <span class="btn-label">Replace All</span>
            </button>
          </div>
          <div id="efr-status"></div>
        </div>
      </div>
    `;
  },

  _frBindEvents(body) {
    const findInput = body.querySelector('#efr-find-input');
    const replaceInput = body.querySelector('#efr-replace-input');

    let findTimer, replaceTimer;
    findInput?.addEventListener('input', () => {
      clearTimeout(findTimer);
      findTimer = setTimeout(() => this._frSearchFind(findInput.value), 150);
    });
    replaceInput?.addEventListener('input', () => {
      clearTimeout(replaceTimer);
      replaceTimer = setTimeout(() => this._frSearchReplace(replaceInput.value), 150);
    });

    body.querySelector('#efr-find-results')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.efr-select-btn');
      if (btn) this._frSelectFind(btn.dataset.entityId);
    });
    body.querySelector('#efr-replace-results')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.efr-select-btn');
      if (btn) this._frSelectReplace(btn.dataset.entityId);
    });

    body.querySelector('#efr-add-btn')?.addEventListener('click', () => this._frAddPair());
    body.querySelector('#efr-replace-all-btn')?.addEventListener('click', () => this._frReplaceAll());
    body.querySelector('#efr-pairs-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.efr-delete-btn');
      if (btn) this._frDeletePair(parseInt(btn.dataset.idx));
    });
  },

  _frSearchFind(query) {
    const q = query.trim().toLowerCase();
    const results = document.getElementById('efr-find-results');
    if (!results) return;
    if (!q) { results.innerHTML = ''; return; }
    const matches = this._frMacroSwitches.filter(s =>
      s.label.toLowerCase().includes(q)
    ).slice(0, 15);
    results.innerHTML = matches.length
      ? matches.map(s => this._frResultRow(s.entity_id, s.label, '')).join('')
      : '<div class="efr-no-results">No matches</div>';
  },

  _frSearchReplace(query) {
    const q = query.trim().toLowerCase();
    const results = document.getElementById('efr-replace-results');
    if (!results) return;
    if (!q) { results.innerHTML = ''; return; }
    const matches = this._frHaSwitches.filter(s =>
      s.label.toLowerCase().includes(q) || s.friendly_name.toLowerCase().includes(q)
    ).slice(0, 15);
    results.innerHTML = matches.length
      ? matches.map(s => this._frResultRow(s.entity_id, s.label, s.friendly_name)).join('')
      : '<div class="efr-no-results">No matches</div>';
  },

  _frResultRow(entityId, label, friendlyName) {
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const sub = friendlyName ? `<span class="efr-friendly">${esc(friendlyName)}</span>` : '';
    return `<div class="efr-result-row">
      <div class="efr-result-info">
        <span class="efr-entity-name">${esc(label)}</span>${sub}
      </div>
      <button class="btn efr-select-btn" data-entity-id="${esc(entityId)}">Select</button>
    </div>`;
  },

  _frSelectFind(entityId) {
    this._frSelectedFind = entityId;
    const el = document.getElementById('efr-find-selected');
    if (el) el.innerHTML = `<span class="efr-chip">${entityId} <button class="efr-chip-x" onclick="SettingsPage._frClearFind()">×</button></span>`;
    document.getElementById('efr-find-results').innerHTML = '';
    document.getElementById('efr-find-input').value = '';
    this._frUpdateAddBtn();
  },

  _frSelectReplace(entityId) {
    this._frSelectedReplace = entityId;
    const el = document.getElementById('efr-replace-selected');
    if (el) el.innerHTML = `<span class="efr-chip">${entityId} <button class="efr-chip-x" onclick="SettingsPage._frClearReplace()">×</button></span>`;
    document.getElementById('efr-replace-results').innerHTML = '';
    document.getElementById('efr-replace-input').value = '';
    this._frUpdateAddBtn();
  },

  _frClearFind() {
    this._frSelectedFind = null;
    const el = document.getElementById('efr-find-selected');
    if (el) el.innerHTML = '';
    this._frUpdateAddBtn();
  },

  _frClearReplace() {
    this._frSelectedReplace = null;
    const el = document.getElementById('efr-replace-selected');
    if (el) el.innerHTML = '';
    this._frUpdateAddBtn();
  },

  _frUpdateAddBtn() {
    const btn = document.getElementById('efr-add-btn');
    if (btn) btn.disabled = !(this._frSelectedFind && this._frSelectedReplace);
  },

  _frAddPair() {
    if (!this._frSelectedFind || !this._frSelectedReplace) return;
    if (this._frSelectedFind === this._frSelectedReplace) {
      App.showToast('Find and Replace are the same entity', 2000);
      return;
    }
    // Check for duplicates
    if (this._frPairs.some(p => p.old === this._frSelectedFind)) {
      App.showToast('That find entity is already in the list', 2000);
      return;
    }
    this._frPairs.push({old: this._frSelectedFind, new: this._frSelectedReplace});
    this._frSelectedFind = null;
    this._frSelectedReplace = null;
    document.getElementById('efr-find-selected').innerHTML = '';
    document.getElementById('efr-replace-selected').innerHTML = '';
    this._frUpdateAddBtn();
    this._frRenderPairs();
  },

  _frDeletePair(idx) {
    this._frPairs.splice(idx, 1);
    this._frRenderPairs();
  },

  _frRenderPairs() {
    const list = document.getElementById('efr-pairs-list');
    const replaceBtn = document.getElementById('efr-replace-all-btn');
    if (!list) return;
    if (!this._frPairs.length) {
      list.innerHTML = '<div class="efr-pairs-empty">No replacements queued</div>';
      if (replaceBtn) replaceBtn.disabled = true;
      return;
    }
    const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
    list.innerHTML = this._frPairs.map((p, i) =>
      `<div class="efr-pair-row">
        <span class="efr-pair-old">${esc(p.old)}</span>
        <span class="material-icons efr-pair-arrow">arrow_forward</span>
        <span class="efr-pair-new">${esc(p.new)}</span>
        <button class="btn efr-delete-btn" data-idx="${i}" title="Remove">
          <span class="material-icons">close</span>
        </button>
      </div>`
    ).join('');
    if (replaceBtn) replaceBtn.disabled = false;
  },

  async _frReplaceAll() {
    if (!this._frPairs.length) return;
    if (!confirm(`Replace ${this._frPairs.length} entity ID(s) in macros.yaml?\nA backup will be created.`)) return;
    const statusEl = document.getElementById('efr-status');
    const btn = document.getElementById('efr-replace-all-btn');
    if (btn) { btn.disabled = true; btn.querySelector('.btn-label').textContent = 'Replacing...'; }
    if (statusEl) statusEl.innerHTML = '';
    try {
      const resp = await fetch('/api/entities/replace', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({replacements: this._frPairs}),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (data.success && data.total_replaced > 0) {
        const lines = data.results.map(r => {
          const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
          if (r.warning) return `<div class="efr-result-line efr-result-warn">${esc(r.old)}: not found</div>`;
          return `<div class="efr-result-line">${esc(r.old)} → ${esc(r.new)}: <strong>${r.count}</strong> occurrence(s)</div>`;
        }).join('');
        if (statusEl) statusEl.innerHTML =
          `<div class="efr-status-box efr-status-ok">
            <strong>${data.total_replaced}</strong> total replacement(s) made. Backup: ${data.backup || 'created'}
            ${lines}
          </div>`;
        App.showToast(`Replaced ${data.total_replaced} occurrence(s)`, 3000);
        this._frPairs = [];
        this._frRenderPairs();
        // Refresh the macro switches list
        try {
          const refreshResp = await fetch('/api/entities/switches', {signal: AbortSignal.timeout(5000)});
          const refreshData = await refreshResp.json();
          this._frMacroSwitches = (refreshData.switches || []).map(id => ({entity_id: id, label: id.replace('switch.', '')}));
        } catch {}
      } else if (data.success && data.total_replaced === 0) {
        if (statusEl) statusEl.innerHTML = '<div class="efr-status-box efr-status-warn">No occurrences found — no changes made</div>';
      } else {
        if (statusEl) statusEl.innerHTML = `<div class="efr-status-box efr-status-err">${data.error || 'Replace failed'}</div>`;
        App.showToast(data.error || 'Replace failed', 4000, 'error');
      }
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<div class="efr-status-box efr-status-err">Error: ${e.message}</div>`;
    } finally {
      if (btn) { btn.disabled = this._frPairs.length === 0; btn.querySelector('.btn-label').textContent = 'Replace All'; }
    }
  },

  // ── User Management ─────────────────────────────────────────────

  async _loadUsers() {
    const container = document.getElementById('users-list');
    if (!container) return;
    container.innerHTML = '<div style="opacity:0.5;padding:12px;text-align:center;">Loading users...</div>';

    try {
      const [usersResp, rolesResp] = await Promise.all([
        fetch('/api/users'),
        fetch('/api/users/roles'),
      ]);
      const usersData = await usersResp.json();
      const rolesData = await rolesResp.json();
      this._availableRoles = rolesData.roles || [];
      this._renderUsersList(usersData.users || []);
    } catch (e) {
      container.innerHTML = '<div style="color:var(--danger);padding:12px;">Failed to load users</div>';
    }

    // Wire up Add User button
    document.getElementById('btn-add-user')?.addEventListener('click', () => this._showUserForm());
  },

  _renderUsersList(users) {
    const container = document.getElementById('users-list');
    if (!container) return;

    if (users.length === 0) {
      container.innerHTML = '<div style="opacity:0.5;padding:12px;text-align:center;">No users configured. Click "Add User" to create one.</div>';
      return;
    }

    container.innerHTML = users.map(u => `
      <div class="control-section" style="margin:0;padding:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        <span class="material-icons" style="font-size:32px;opacity:${u.enabled ? '1' : '0.3'};">
          ${u.enabled ? 'person' : 'person_off'}
        </span>
        <div style="flex:1;min-width:150px;">
          <div style="font-weight:bold;font-size:15px;">${this._escHtml(u.display_name)}</div>
          <div style="font-size:13px;opacity:0.7;">@${this._escHtml(u.username)} &middot; ${this._escHtml(u.role)}</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn" data-edit-user="${this._escAttr(u.username)}" style="min-width:auto;padding:8px 12px;">
            <span class="material-icons" style="font-size:18px;">edit</span>
          </button>
          <button class="btn" data-toggle-user="${this._escAttr(u.username)}" data-enabled="${u.enabled}" style="min-width:auto;padding:8px 12px;">
            <span class="material-icons" style="font-size:18px;">${u.enabled ? 'block' : 'check_circle'}</span>
          </button>
          <button class="btn" data-delete-user="${this._escAttr(u.username)}" style="min-width:auto;padding:8px 12px;color:var(--danger);">
            <span class="material-icons" style="font-size:18px;">delete</span>
          </button>
        </div>
      </div>
    `).join('');

    // Wire up action buttons
    container.querySelectorAll('[data-edit-user]').forEach(btn => {
      btn.addEventListener('click', () => this._showEditUserForm(btn.dataset.editUser));
    });
    container.querySelectorAll('[data-toggle-user]').forEach(btn => {
      btn.addEventListener('click', () => this._toggleUser(btn.dataset.toggleUser, btn.dataset.enabled === 'true'));
    });
    container.querySelectorAll('[data-delete-user]').forEach(btn => {
      btn.addEventListener('click', () => this._deleteUser(btn.dataset.deleteUser));
    });
  },

  _showUserForm(editUser = null) {
    const roles = this._availableRoles || [];
    const isEdit = !!editUser;
    const title = isEdit ? 'Edit User' : 'New User';

    const overlay = document.createElement('div');
    overlay.id = 'user-form-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
      <div style="background:var(--bg-secondary, #1e1e2e);border-radius:12px;padding:24px;max-width:400px;width:100%;">
        <h3 style="margin:0 0 16px 0;">${title}</h3>
        ${!isEdit ? `
        <label style="display:block;margin-bottom:4px;font-size:13px;">Username</label>
        <input id="uf-username" type="text" placeholder="e.g. john" autocapitalize="none" autocomplete="off"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:12px;font-size:15px;">
        ` : ''}
        <label style="display:block;margin-bottom:4px;font-size:13px;">Display Name</label>
        <input id="uf-display" type="text" placeholder="e.g. John Smith" autocomplete="off"
               value="${isEdit && editUser ? this._escAttr(editUser.display_name || '') : ''}"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:12px;font-size:15px;">
        ${!isEdit ? `
        <label style="display:block;margin-bottom:4px;font-size:13px;">Password</label>
        <input id="uf-password" type="password" placeholder="Min 4 characters" autocomplete="new-password"
               style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:12px;font-size:15px;">
        ` : ''}
        <label style="display:block;margin-bottom:4px;font-size:13px;">Role</label>
        <select id="uf-role" style="width:100%;padding:10px;border-radius:6px;border:1px solid #444;background:#111;color:#fff;margin-bottom:16px;font-size:15px;">
          ${roles.map(r => `<option value="${this._escAttr(r.key)}" ${isEdit && editUser && editUser.role === r.key ? 'selected' : ''}>${this._escHtml(r.displayName)}</option>`).join('')}
        </select>
        <div id="uf-error" style="color:var(--danger);font-size:13px;margin-bottom:8px;display:none;"></div>
        <div style="display:flex;gap:8px;">
          <button class="btn" id="uf-cancel" style="flex:1;"><span class="btn-label">Cancel</span></button>
          <button class="btn active" id="uf-save" style="flex:1;"><span class="btn-label">${isEdit ? 'Save' : 'Create'}</span></button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('uf-cancel').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.getElementById('uf-save').addEventListener('click', async () => {
      const errEl = document.getElementById('uf-error');
      errEl.style.display = 'none';

      if (isEdit) {
        const display_name = document.getElementById('uf-display').value.trim();
        const role = document.getElementById('uf-role').value;
        try {
          const resp = await fetch(`/api/users/${encodeURIComponent(editUser.username)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ display_name, role }),
          });
          const data = await resp.json();
          if (!resp.ok) { errEl.textContent = data.error || 'Failed'; errEl.style.display = 'block'; return; }
          overlay.remove();
          App.showToast('User updated', 2000);
          this._loadUsers();
        } catch (e) { errEl.textContent = 'Network error'; errEl.style.display = 'block'; }
      } else {
        const username = document.getElementById('uf-username').value.trim();
        const display_name = document.getElementById('uf-display').value.trim();
        const password = document.getElementById('uf-password').value;
        const role = document.getElementById('uf-role').value;
        try {
          const resp = await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, display_name, password, role }),
          });
          const data = await resp.json();
          if (!resp.ok) { errEl.textContent = data.error || 'Failed'; errEl.style.display = 'block'; return; }
          overlay.remove();
          App.showToast(`User "${username}" created`, 2000);
          this._loadUsers();
        } catch (e) { errEl.textContent = 'Network error'; errEl.style.display = 'block'; }
      }
    });
  },

  async _showEditUserForm(username) {
    try {
      const resp = await fetch('/api/users');
      const data = await resp.json();
      const user = (data.users || []).find(u => u.username === username);
      if (!user) { App.showToast('User not found', 2000, 'error'); return; }
      this._showUserForm(user);
    } catch (e) {
      App.showToast('Failed to load user', 2000, 'error');
    }
  },

  async _toggleUser(username, currentlyEnabled) {
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(username)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !currentlyEnabled }),
      });
      if (resp.ok) {
        App.showToast(`User ${currentlyEnabled ? 'disabled' : 'enabled'}`, 2000);
        this._loadUsers();
      }
    } catch (e) {
      App.showToast('Failed to update user', 2000, 'error');
    }
  },

  async _deleteUser(username) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
      if (resp.ok) {
        App.showToast(`User "${username}" deleted`, 2000);
        this._loadUsers();
      } else {
        const data = await resp.json();
        App.showToast(data.error || 'Failed to delete', 2000, 'error');
      }
    } catch (e) {
      App.showToast('Network error', 2000, 'error');
    }
  },

  _escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  _escAttr(str) {
    return (str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  destroy() {
    if (this._switchPanelTimer) { clearInterval(this._switchPanelTimer); this._switchPanelTimer = null; }
    if (this._ecoFlowTimer) { clearInterval(this._ecoFlowTimer); this._ecoFlowTimer = null; }
    this._thermostatTimers.forEach(t => clearInterval(t));
    this._thermostatTimers = [];
    this._haDomainSummary = null;
    clearTimeout(this._haSearchTimer);
  }
};
