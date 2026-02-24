const SettingsPage = {
  pollTimer: null,

  render(container) {
    const locations = Auth.getLocations();
    const currentLoc = Auth.currentLocation;

    container.innerHTML = `
      <div class="page-header">
        <h1>SETTINGS</h1>
      </div>

      <div class="control-section">
        <div class="section-title">Tablet Location</div>
        <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
          Select which location this tablet is assigned to. This controls which menu items are visible.
        </div>
        <div class="control-grid" style="grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));">
          ${locations.map(loc => `
            <button class="btn ${loc.key === currentLoc ? 'active' : ''}" data-location="${loc.key}">
              <span class="material-icons">${loc.key === currentLoc ? 'radio_button_checked' : 'radio_button_unchecked'}</span>
              <span class="btn-label">${loc.displayName}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Audio Mixer (X32)</div>
        <div id="mixer-container">
          <div class="text-center" style="opacity:0.5;">Loading mixer status...</div>
        </div>
        <div class="mt-16">
          <div class="section-title" style="font-size:16px;">Mixer Scenes</div>
          <div class="scene-grid" id="x32-scenes"></div>
        </div>
        <div class="mt-16">
          <div class="section-title" style="font-size:16px;">Aux Channels</div>
          <div id="aux-container" class="mixer-grid"></div>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">System Health</div>
        <div class="text-center">
          <button class="btn" id="btn-open-health" style="display:inline-flex;max-width:300px;">
            <span class="material-icons">monitor_heart</span>
            <span class="btn-label">Open Health Dashboard</span>
          </button>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Home Assistant Entities</div>
        <div class="info-text" style="margin:0 0 12px 0;font-size:14px;">
          Browse all HA entities for configuring macros and buttons, or download a YAML reference file.
        </div>
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

      <div class="control-section">
        <div class="section-title">System Information</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:14px;">
          <div>Version:</div><div id="info-version">--</div>
          <div>Location:</div><div id="info-location">--</div>
          <div>Connection:</div><div id="info-connection">--</div>
          <div>OBS Status:</div><div id="info-obs">--</div>
          <div>X32 Status:</div><div id="info-x32">--</div>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Audit Log</div>
        <div class="text-center" style="margin-bottom:12px;">
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
          <div id="audit-log" style="max-height:400px;overflow-y:auto;font-size:12px;font-family:monospace;"></div>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Scheduled Automations</div>
        <div id="schedule-container">
          <div class="text-center" style="opacity:0.5;font-size:14px;">Loading schedules...</div>
        </div>
        <div class="mt-16 text-center">
          <button class="btn" id="btn-add-schedule" style="display:inline-flex;max-width:300px;">
            <span class="material-icons">add_alarm</span>
            <span class="btn-label">Add Schedule</span>
          </button>
        </div>
        <div id="schedule-form" class="hidden" style="margin-top:16px;background:#1a1a2e;padding:16px;border-radius:8px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <label style="font-size:12px;opacity:0.7;">Name</label>
              <input type="text" id="sched-name" placeholder="e.g. Sunday Morning Setup"
                style="width:100%;padding:8px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:14px;font-family:inherit;">
            </div>
            <div>
              <label style="font-size:12px;opacity:0.7;">Macro</label>
              <select id="sched-macro" style="width:100%;padding:8px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:14px;font-family:inherit;"></select>
            </div>
            <div>
              <label style="font-size:12px;opacity:0.7;">Time</label>
              <input type="time" id="sched-time" value="08:00"
                style="width:100%;padding:8px;border-radius:4px;border:1px solid #444;background:#222;color:#fff;font-size:14px;font-family:inherit;">
            </div>
            <div>
              <label style="font-size:12px;opacity:0.7;">Days</label>
              <div id="sched-days" style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;">
                <label style="font-size:12px;"><input type="checkbox" value="0" checked> Mon</label>
                <label style="font-size:12px;"><input type="checkbox" value="1" checked> Tue</label>
                <label style="font-size:12px;"><input type="checkbox" value="2" checked> Wed</label>
                <label style="font-size:12px;"><input type="checkbox" value="3" checked> Thu</label>
                <label style="font-size:12px;"><input type="checkbox" value="4" checked> Fri</label>
                <label style="font-size:12px;"><input type="checkbox" value="5" checked> Sat</label>
                <label style="font-size:12px;"><input type="checkbox" value="6" checked> Sun</label>
              </div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end;">
            <button class="btn" id="btn-sched-cancel" style="min-height:auto;padding:8px 16px;">Cancel</button>
            <button class="btn btn-success" id="btn-sched-save" style="min-height:auto;padding:8px 16px;background:#00b050;border-color:#00b050;">Save</button>
          </div>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Connected Tablets</div>
        <div id="sessions-container">
          <div class="text-center" style="opacity:0.5;font-size:14px;">Load audit log to see connected tablets</div>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Security</div>
        <div class="control-grid" style="grid-template-columns:1fr 1fr;">
          <button class="btn" id="btn-change-pin"><span class="material-icons">lock</span><span class="btn-label">Change PIN</span></button>
          <button class="btn" id="btn-logout"><span class="material-icons">logout</span><span class="btn-label">Lock Settings</span></button>
        </div>
      </div>

      <div class="text-center mt-16">
        <button class="btn" id="btn-reload-app" style="display:inline-flex;max-width:300px;">
          <span class="material-icons">refresh</span>
          <span class="btn-label">Reload Application</span>
        </button>
      </div>
    `;
  },

  init() {
    // Location selection
    document.querySelectorAll('[data-location]').forEach(btn => {
      btn.addEventListener('click', () => {
        const loc = btn.dataset.location;
        Auth.setLocation(loc);
        Router.updateNavVisibility();
        // Re-render to show updated selection
        Router.navigate('settings');
        App.updateStatusBar();
        App.showToast('Location set to: ' + Auth.getDisplayName());
      });
    });

    // Load mixer
    this.loadMixer();
    this.pollTimer = setInterval(() => this.loadMixer(), 5000);

    // System info
    document.getElementById('info-version')?.textContent && (document.getElementById('info-version').textContent = App.settings?.app?.version || '--');
    document.getElementById('info-location')?.textContent && (document.getElementById('info-location').textContent = Auth.getDisplayName());
    const infoVersion = document.getElementById('info-version');
    if (infoVersion) infoVersion.textContent = App.settings?.app?.version || '--';
    const infoLoc = document.getElementById('info-location');
    if (infoLoc) infoLoc.textContent = Auth.getDisplayName();

    // Health dashboard (opens in panel overlay)
    document.getElementById('btn-open-health')?.addEventListener('click', () => this.openHealthPanel());

    // HA Entity Browser (opens in panel overlay)
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

    // Audit log
    document.getElementById('btn-load-audit')?.addEventListener('click', () => this.loadAuditLog());
    document.getElementById('audit-filter')?.addEventListener('change', () => this.filterAuditLog());

    // Schedules
    this.loadSchedules();
    this.loadMacroDropdown();

    document.getElementById('btn-add-schedule')?.addEventListener('click', () => {
      document.getElementById('schedule-form')?.classList.remove('hidden');
    });
    document.getElementById('btn-sched-cancel')?.addEventListener('click', () => {
      document.getElementById('schedule-form')?.classList.add('hidden');
    });
    document.getElementById('btn-sched-save')?.addEventListener('click', () => this.saveSchedule());
  },

  _auditData: [],

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
  // Health Dashboard Panel (iframe embed of existing health dashboard)
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

  _haEntities: null,  // cached raw response { domains: { domain: [entities] } }

  async openHABrowserPanel() {
    const self = this;

    App.showPanel('Home Assistant Entities', async (body) => {
      // Render search toolbar + results area inside the panel body
      body.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap;">
          <input type="text" id="ha-search" placeholder="Search entities (e.g. switch, ecoflow, climate)..."
            style="flex:1;min-width:200px;padding:8px 12px;border-radius:6px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:14px;font-family:inherit;">
          <select id="ha-domain-filter" style="padding:8px;border-radius:6px;border:1px solid var(--input-border);background:var(--input-bg);color:var(--text);font-size:13px;font-family:inherit;">
            <option value="">All Domains</option>
          </select>
          <span id="ha-entity-count" style="font-size:12px;opacity:0.6;white-space:nowrap;"></span>
        </div>
        <div id="ha-results"></div>
      `;

      body.querySelector('#ha-search').addEventListener('input', () => self._renderHAResults(body));
      body.querySelector('#ha-domain-filter').addEventListener('change', () => self._renderHAResults(body));

      // Load data (use cache if available)
      if (!self._haEntities) {
        body.querySelector('#ha-results').innerHTML = '<div style="opacity:0.5;padding:8px;">Loading entities...</div>';
        try {
          const resp = await fetch('/api/ha/entities', {
            headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
          });
          self._haEntities = await resp.json();
        } catch (e) {
          body.querySelector('#ha-results').innerHTML = '<div style="color:var(--danger);padding:8px;">Failed to load entities. Is the gateway running?</div>';
          return;
        }
      }

      // Populate domain dropdown
      const domainSelect = body.querySelector('#ha-domain-filter');
      if (domainSelect && self._haEntities.domains) {
        const domains = Object.keys(self._haEntities.domains).sort();
        domainSelect.innerHTML = '<option value="">All Domains (' + domains.length + ')</option>' +
          domains.map(d => {
            const count = self._haEntities.domains[d].length;
            return `<option value="${d}">${d} (${count})</option>`;
          }).join('');
      }

      self._renderHAResults(body);
    });
  },

  _renderHAResults(container) {
    const results = container.querySelector('#ha-results');
    const countEl = container.querySelector('#ha-entity-count');
    if (!results || !this._haEntities?.domains) return;

    const query = (container.querySelector('#ha-search')?.value || '').toLowerCase().trim();
    const domainFilter = container.querySelector('#ha-domain-filter')?.value || '';

    // Flatten all entities, optionally filtering by domain
    let entities = [];
    const domains = domainFilter
      ? { [domainFilter]: this._haEntities.domains[domainFilter] || [] }
      : this._haEntities.domains;

    for (const [domain, items] of Object.entries(domains)) {
      for (const ent of items) {
        entities.push({ ...ent, domain });
      }
    }

    // Apply text search
    if (query) {
      entities = entities.filter(e =>
        (e.entity_id || '').toLowerCase().includes(query) ||
        (e.friendly_name || '').toLowerCase().includes(query) ||
        (e.state || '').toLowerCase().includes(query)
      );
    }

    if (countEl) countEl.textContent = `${entities.length} entities`;

    if (entities.length === 0) {
      results.innerHTML = '<div style="opacity:0.5;padding:8px;">No matching entities found.</div>';
      return;
    }

    // Cap at 200 to avoid DOM overload
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
              <td style="padding:6px 8px;color:var(--info);cursor:pointer;white-space:nowrap;" title="Click to copy">${e.entity_id}</td>
              <td style="padding:6px 8px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${e.friendly_name || '--'}</td>
              <td style="padding:6px 8px;font-weight:bold;">${e.state || '--'}</td>
              <td style="padding:6px 8px;color:var(--text-secondary);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${attrStr}">${truncAttrs || '--'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${showMore ? `<div style="padding:8px;opacity:0.6;text-align:center;">Showing first 200 of ${entities.length} — narrow your search to see more.</div>` : ''}
    `;

    // Click to copy entity_id
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
    this._haEntities = null;
  }
};
