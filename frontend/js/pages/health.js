// Health Dashboard Page — absorbed from STP_healthdash (Phase 4 consolidation)
const HealthPage = {
  _pollTimer: null,
  _services: [],
  _currentLogsServiceId: null,
  _userToggled: new Set(),   // cards user has manually toggled — don't auto-collapse/expand these
  _prevLevels: {},           // previous severity per service — detect transitions

  render(container) {
    container.innerHTML = `
      <div class="health-page">
        <div class="health-header">
          <div class="health-header-left">
            <button class="btn-action" id="health-back-btn" title="Back">
              <span class="material-icons">arrow_back</span>
            </button>
            <h1 class="health-title">Critical Systems Health Dashboard</h1>
            <div class="health-subtitle">
              Last update: <span id="health-last-update">—</span>
            </div>
          </div>
          <div class="health-header-right">
            <div class="health-severity" id="health-severity">
              <span class="health-sev-tile health-sev-down hidden" id="health-sev-down" title="Down">
                <span id="health-sev-down-count">0</span>
              </span>
              <span class="health-sev-tile health-sev-warn hidden" id="health-sev-warn" title="Warning">
                <span id="health-sev-warn-count">0</span>
              </span>
              <span class="health-sev-tile health-sev-ok hidden" id="health-sev-ok" title="Healthy">
                <span id="health-sev-ok-count">0</span>
              </span>
            </div>
            <button class="btn-action" id="health-refresh-btn" title="Force refresh all checks">
              <span class="material-icons">refresh</span>
            </button>
          </div>
        </div>

        <div id="health-banner" class="health-banner hidden"></div>

        <div class="health-grid" id="health-grid">
          <div class="health-loading">Loading services...</div>
        </div>
      </div>

      <!-- Logs Modal -->
      <div id="health-logs-overlay" class="overlay hidden">
        <div class="modal health-logs-modal">
          <div class="modal-header-bar">
            <h2 id="health-logs-title">Logs</h2>
            <button class="modal-close" id="health-logs-close">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div class="modal-body">
            <div class="health-logs-toolbar">
              <span class="health-logs-hint">Last 200 lines</span>
              <button class="btn-action-sm" id="health-logs-refresh">
                <span class="material-icons" style="font-size:16px;">refresh</span>
              </button>
            </div>
            <pre class="health-logs-pre" id="health-logs-pre">Loading...</pre>
          </div>
        </div>
      </div>

      <!-- Confirm Recovery Modal -->
      <div id="health-confirm-overlay" class="overlay hidden">
        <div class="modal health-confirm-modal">
          <div class="modal-header-bar">
            <h2>Confirm Action</h2>
            <button class="modal-close" id="health-confirm-close">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div class="modal-body">
            <p id="health-confirm-body">Are you sure?</p>
            <div class="health-confirm-actions">
              <button class="btn-action-sm" id="health-confirm-cancel">Cancel</button>
              <button class="btn-action-sm btn-danger" id="health-confirm-yes">Yes, restart</button>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  async init() {
    // Load services list and build the grid
    await this._loadServices();
    this._buildGrid();
    this._bindEvents();
    await this._fetchStatus();
    this._pollTimer = setInterval(() => this._fetchStatus(), 5000);
  },

  destroy() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._userToggled = new Set();
    this._prevLevels = {};
  },

  // --- Data Loading ---

  async _loadServices() {
    try {
      const resp = await fetch('/api/healthdash/services', { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      this._services = data.services || [];
    } catch (e) {
      console.error('Failed to load health services:', e);
      this._services = [];
    }
  },

  _buildGrid() {
    const grid = document.getElementById('health-grid');
    if (!grid) return;

    if (this._services.length === 0) {
      grid.innerHTML = '<div class="health-loading">No services configured</div>';
      return;
    }

    grid.innerHTML = this._services.map(svc => `
      <div class="health-card" id="hcard-${this._safeId(svc.id)}" data-type="${svc.type}">
        <div class="health-card-header health-card-toggle" data-toggle-target="${this._safeId(svc.id)}">
          <div class="health-card-title-row">
            <span class="health-dot" id="hdot-${this._safeId(svc.id)}"></span>
            <span class="health-card-name">${this._esc(svc.name)}</span>
            <span class="material-icons health-expand-icon" id="hexpand-${this._safeId(svc.id)}" style="font-size:18px;opacity:0.4;margin-left:auto;">expand_more</span>
          </div>
          <div class="health-card-actions" onclick="event.stopPropagation();">
            <button class="btn-action-sm" data-health-action="logs" data-health-svc="${svc.id}" title="View logs">
              <span class="material-icons" style="font-size:14px;">description</span>
            </button>
            ${svc.recovery ? `
              <button class="btn-action-sm btn-danger-sm" data-health-action="recover" data-health-svc="${svc.id}" title="Restart">
                <span class="material-icons" style="font-size:14px;">restart_alt</span>
              </button>
            ` : ''}
          </div>
        </div>
        <div class="health-card-subtitle" id="hsub-${this._safeId(svc.id)}">—</div>
        <div class="health-card-body hidden" id="hbody-${this._safeId(svc.id)}">
          <div class="health-card-stats">
            <div class="health-stat">
              <div class="health-stat-label">Status</div>
              <div class="health-stat-value" id="hstatus-${this._safeId(svc.id)}">—</div>
            </div>
            <div class="health-stat">
              <div class="health-stat-label">Latency</div>
              <div class="health-stat-value" id="hlatency-${this._safeId(svc.id)}">—</div>
            </div>
            <div class="health-stat">
              <div class="health-stat-label">Last OK</div>
              <div class="health-stat-value" id="hlastok-${this._safeId(svc.id)}">—</div>
            </div>
            <div class="health-stat">
              <div class="health-stat-label">Last Check</div>
              <div class="health-stat-value" id="hcheck-${this._safeId(svc.id)}">—</div>
            </div>
          </div>
          <!-- Details (key/value pairs) -->
          <div class="health-details hidden" id="hdetails-${this._safeId(svc.id)}"></div>
          <!-- Error -->
          <div class="health-error hidden" id="herr-${this._safeId(svc.id)}"></div>
        </div>
        <!-- Composite members -->
        <div class="health-members hidden" id="hmembers-${this._safeId(svc.id)}">
          <div class="health-members-list" id="hmlist-${this._safeId(svc.id)}"></div>
        </div>
      </div>
    `).join('');

    // Wire up card header toggles (body + members collapse together)
    grid.querySelectorAll('.health-card-toggle').forEach(header => {
      header.style.cursor = 'pointer';
      header.addEventListener('click', () => {
        const safe = header.dataset.toggleTarget;
        this._userToggled.add(safe);          // remember manual toggle
        const body = document.getElementById(`hbody-${safe}`);
        if (body && body.classList.contains('hidden')) {
          this._expandCard(safe);
        } else {
          this._collapseCard(safe);
        }
      });
    });
  },

  // --- Status Polling ---

  async _fetchStatus() {
    try {
      const resp = await fetch('/api/healthdash/status', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      this._setBanner(null);
      const timeEl = document.getElementById('health-last-update');
      if (timeEl) timeEl.textContent = this._fmtTime(data.generated_at);

      this._updateSeverity(data);

      const results = data.results || {};
      for (const [id, result] of Object.entries(results)) {
        this._updateCard(id, result);
      }

      // Auto-collapse cards that become healthy, auto-expand cards that become unhealthy
      this._applyAutoCollapse(results);

      // Sort cards by severity: red first, then yellow, then green
      this._sortCards();
    } catch (e) {
      this._setBanner(`Failed to refresh health status: ${e}`, 'danger');
    }
  },

  _updateSeverity(data) {
    const results = data.results || {};
    const memberIds = new Set();

    // Collect member IDs from composites
    for (const svc of Object.values(results)) {
      const rows = svc?.details?.member_rows;
      if (Array.isArray(rows)) {
        rows.forEach(r => { if (r?.id) memberIds.add(String(r.id)); });
      }
    }

    const counts = { healthy: 0, warning: 0, down: 0 };
    for (const [id, svc] of Object.entries(results)) {
      const rows = svc?.details?.member_rows;
      if (Array.isArray(rows)) {
        rows.forEach(r => { counts[r?.level || 'down'] = (counts[r?.level || 'down'] || 0) + 1; });
      } else if (!memberIds.has(String(id))) {
        const lvl = svc?.status?.level || 'down';
        counts[lvl] = (counts[lvl] || 0) + 1;
      }
    }

    const setTile = (elId, countId, count) => {
      const el = document.getElementById(elId);
      const cel = document.getElementById(countId);
      if (el) el.classList.toggle('hidden', count === 0);
      if (cel) cel.textContent = String(count);
    };

    setTile('health-sev-down', 'health-sev-down-count', counts.down);
    setTile('health-sev-warn', 'health-sev-warn-count', counts.warning);
    setTile('health-sev-ok', 'health-sev-ok-count', counts.healthy);
  },

  _updateCard(svcId, result) {
    const safe = this._safeId(svcId);
    const card = document.getElementById(`hcard-${safe}`);
    if (!card) return;

    const level = result?.status?.level || 'down';
    const label = result?.status?.label || 'Down';
    const msg = result?.message || '—';

    // Update card border color
    card.className = `health-card health-card-${level}`;
    card.dataset.type = card.dataset.type || '';

    // Dot
    const dot = document.getElementById(`hdot-${safe}`);
    if (dot) dot.className = `health-dot health-dot-${level}`;

    // Subtitle
    const sub = document.getElementById(`hsub-${safe}`);
    if (sub) sub.textContent = msg;

    // Stats
    const statusEl = document.getElementById(`hstatus-${safe}`);
    if (statusEl) statusEl.textContent = label;

    const latencyEl = document.getElementById(`hlatency-${safe}`);
    if (latencyEl) latencyEl.textContent = result?.latency_ms != null ? `${result.latency_ms} ms` : '—';

    const lastokEl = document.getElementById(`hlastok-${safe}`);
    if (lastokEl) lastokEl.textContent = this._fmtTime(result?.last_ok_at);

    const checkEl = document.getElementById(`hcheck-${safe}`);
    if (checkEl) checkEl.textContent = this._fmtTime(result?.checked_at);

    // Error box
    const errEl = document.getElementById(`herr-${safe}`);
    if (errEl) {
      if (level === 'down') {
        errEl.textContent = msg || 'Down';
        errEl.classList.remove('hidden');
      } else {
        errEl.classList.add('hidden');
      }
    }

    // Composite members
    const memberRows = result?.details?.member_rows;
    const membersWrap = document.getElementById(`hmembers-${safe}`);
    const memberList = document.getElementById(`hmlist-${safe}`);

    if (Array.isArray(memberRows) && memberRows.length > 0) {
      // Only auto-show members if the card body is currently expanded
      const bodyEl = document.getElementById(`hbody-${safe}`);
      if (membersWrap && bodyEl && !bodyEl.classList.contains('hidden')) {
        membersWrap.classList.remove('hidden');
      }
      if (memberList) {
        memberList.innerHTML = memberRows.map(r => {
          const mid = this._safeId(r.id || r.name || '');
          const rlvl = r.level || 'down';
          const rmsg = r.message || '—';
          const rlatency = r.latency_ms != null ? `${r.latency_ms} ms` : '—';
          const rchecked = this._fmtTime(r.checked_at);
          const rlastok = this._fmtTime(r.last_ok_at);
          return `
            <div class="health-member-row health-member-toggle" data-member-detail="mdetail-${safe}-${mid}">
              <div class="health-member-summary">
                <span class="health-dot health-dot-${rlvl}"></span>
                <span class="health-member-name">${this._esc(r.name || r.id)}</span>
                <span class="health-member-label">${this._esc(r.label || rlvl)}</span>
                <span class="material-icons health-member-chevron" style="font-size:16px;opacity:0.4;">expand_more</span>
              </div>
              <div class="health-member-detail hidden" id="mdetail-${safe}-${mid}">
                <div class="health-member-detail-grid">
                  <span class="health-stat-label">Message</span><span>${this._esc(rmsg)}</span>
                  <span class="health-stat-label">Latency</span><span>${rlatency}</span>
                  <span class="health-stat-label">Last OK</span><span>${rlastok}</span>
                  <span class="health-stat-label">Last Check</span><span>${rchecked}</span>
                </div>
              </div>
            </div>
          `;
        }).join('');

        // Wire up member row toggles
        memberList.querySelectorAll('.health-member-toggle').forEach(row => {
          row.style.cursor = 'pointer';
          row.addEventListener('click', () => {
            const detailId = row.dataset.memberDetail;
            const detail = document.getElementById(detailId);
            const chevron = row.querySelector('.health-member-chevron');
            if (detail) {
              const expanding = detail.classList.contains('hidden');
              detail.classList.toggle('hidden');
              if (chevron) chevron.textContent = expanding ? 'expand_less' : 'expand_more';
            }
          });
        });
      }
      // Hide simple details for composites
      const detailsEl = document.getElementById(`hdetails-${safe}`);
      if (detailsEl) detailsEl.classList.add('hidden');
    } else {
      if (membersWrap) membersWrap.classList.add('hidden');
      // Show simple details
      this._renderDetails(safe, result?.details);
    }
  },

  _renderDetails(safe, details) {
    const el = document.getElementById(`hdetails-${safe}`);
    if (!el) return;

    if (!details || typeof details !== 'object' || Array.isArray(details.member_rows)) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }

    const keys = Object.keys(details).filter(k => k !== 'member_rows');
    if (keys.length === 0) {
      el.classList.add('hidden');
      return;
    }

    el.innerHTML = keys.map(k => {
      const v = details[k];
      const val = (v && typeof v === 'object') ? JSON.stringify(v) : String(v ?? '—');
      return `
        <div class="health-detail-row">
          <span class="health-detail-key">${this._esc(k)}</span>
          <span class="health-detail-val">${this._esc(val)}</span>
        </div>
      `;
    }).join('');
    el.classList.remove('hidden');
  },

  // --- Events ---

  _bindEvents() {
    // Back button
    document.getElementById('health-back-btn')?.addEventListener('click', () => {
      Router.navigate('home');
    });

    // Refresh button
    const refreshBtn = document.getElementById('health-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        try {
          await fetch('/api/healthdash/check_now', { method: 'POST' });
          await this._fetchStatus();
        } catch (e) {
          this._setBanner(`Force check failed: ${e}`, 'danger');
        }
      });
    }

    // Delegated click handler for logs/recover buttons
    document.addEventListener('click', this._handleAction.bind(this));

    // Logs modal close
    const logsClose = document.getElementById('health-logs-close');
    if (logsClose) logsClose.addEventListener('click', () => {
      document.getElementById('health-logs-overlay')?.classList.add('hidden');
    });

    // Logs refresh
    const logsRefresh = document.getElementById('health-logs-refresh');
    if (logsRefresh) logsRefresh.addEventListener('click', () => this._refreshLogs());

    // Confirm modal close/cancel
    const confirmClose = document.getElementById('health-confirm-close');
    const confirmCancel = document.getElementById('health-confirm-cancel');
    if (confirmClose) confirmClose.addEventListener('click', () => {
      document.getElementById('health-confirm-overlay')?.classList.add('hidden');
    });
    if (confirmCancel) confirmCancel.addEventListener('click', () => {
      document.getElementById('health-confirm-overlay')?.classList.add('hidden');
    });
  },

  _handleAction(e) {
    const btn = e.target.closest('[data-health-action]');
    if (!btn) return;

    const action = btn.dataset.healthAction;
    const svcId = btn.dataset.healthSvc;
    if (!action || !svcId) return;

    if (action === 'logs') this._openLogs(svcId);
    else if (action === 'recover') this._confirmRecover(svcId);
  },

  async _openLogs(serviceId) {
    this._currentLogsServiceId = serviceId;
    document.getElementById('health-logs-overlay')?.classList.remove('hidden');
    await this._refreshLogs();
  },

  async _refreshLogs() {
    if (!this._currentLogsServiceId) return;
    const pre = document.getElementById('health-logs-pre');
    if (pre) pre.textContent = 'Loading...';

    try {
      const resp = await fetch(`/api/healthdash/logs/${encodeURIComponent(this._currentLogsServiceId)}?lines=200`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const title = document.getElementById('health-logs-title');
      if (title) title.textContent = `${data.name || this._currentLogsServiceId} — Logs`;
      if (pre) pre.textContent = data.log || '(No log output)';
    } catch (e) {
      if (pre) pre.textContent = `Failed to load logs: ${e}`;
    }
  },

  _confirmRecover(serviceId) {
    const body = document.getElementById('health-confirm-body');
    const yesBtn = document.getElementById('health-confirm-yes');
    if (body) body.textContent = `Are you sure you want to restart "${serviceId}"?`;

    document.getElementById('health-confirm-overlay')?.classList.remove('hidden');

    if (yesBtn) {
      yesBtn.onclick = async () => {
        yesBtn.disabled = true;
        try {
          const resp = await fetch(`/api/healthdash/recover/${encodeURIComponent(serviceId)}`, { method: 'POST' });
          const data = await resp.json().catch(() => ({}));
          if (!resp.ok || !data.ok) throw new Error(data.message || `HTTP ${resp.status}`);
          this._setBanner(data.message || 'Recovery requested.', 'info');
          document.getElementById('health-confirm-overlay')?.classList.add('hidden');
          setTimeout(() => this._fetchStatus(), 500);
        } catch (e) {
          this._setBanner(`Recovery failed: ${e}`, 'danger');
        } finally {
          yesBtn.disabled = false;
        }
      };
    }
  },

  // --- Card collapse/expand helpers ---

  _collapseCard(safe) {
    const body = document.getElementById(`hbody-${safe}`);
    const members = document.getElementById(`hmembers-${safe}`);
    const icon = document.getElementById(`hexpand-${safe}`);
    if (body) body.classList.add('hidden');
    if (members) members.classList.add('hidden');
    if (icon) icon.textContent = 'expand_more';
  },

  _expandCard(safe) {
    const body = document.getElementById(`hbody-${safe}`);
    const members = document.getElementById(`hmembers-${safe}`);
    const icon = document.getElementById(`hexpand-${safe}`);
    if (body) body.classList.remove('hidden');
    // Only show members if it has content
    if (members) {
      const list = members.querySelector('.health-members-list');
      if (list && list.children.length > 0) members.classList.remove('hidden');
    }
    if (icon) icon.textContent = 'expand_less';
  },

  _applyAutoCollapse(results) {
    // On every poll, auto-collapse cards that transition to healthy
    // and auto-expand cards that transition to unhealthy.
    // Handles gateway warmup: services start "down" then go green once synced.
    for (const svc of this._services) {
      const safe = this._safeId(svc.id);
      if (this._userToggled.has(safe)) continue;  // respect manual toggles

      const result = results[svc.id];
      const level = result?.status?.level || 'down';
      const prev = this._prevLevels[svc.id];  // undefined on first poll

      // Act on transitions (or first load when prev is undefined)
      if (level !== prev) {
        if (level === 'healthy') {
          this._collapseCard(safe);
        } else {
          this._expandCard(safe);
        }
      }

      this._prevLevels[svc.id] = level;
    }
  },

  _sortCards() {
    const grid = document.getElementById('health-grid');
    if (!grid) return;

    const severityOrder = { down: 0, warning: 1, healthy: 2 };
    const cards = Array.from(grid.querySelectorAll('.health-card'));

    cards.sort((a, b) => {
      const aLevel = (a.className.match(/health-card-(down|warning|healthy)/) || [])[1] || 'healthy';
      const bLevel = (b.className.match(/health-card-(down|warning|healthy)/) || [])[1] || 'healthy';
      return (severityOrder[aLevel] ?? 2) - (severityOrder[bLevel] ?? 2);
    });

    // Re-append in sorted order (moves existing DOM nodes)
    cards.forEach(card => grid.appendChild(card));
  },

  // --- Helpers ---

  _setBanner(msg, kind) {
    const banner = document.getElementById('health-banner');
    if (!banner) return;
    if (!msg) {
      banner.classList.add('hidden');
      banner.textContent = '';
      return;
    }
    banner.textContent = msg;
    banner.className = `health-banner health-banner-${kind || 'warning'}`;
  },

  _fmtTime(ts) {
    if (!ts) return '—';
    const raw = typeof ts === 'string' && !ts.endsWith('Z') && /\d{4}-\d{2}-\d{2}/.test(ts) ? ts + 'Z' : ts;
    const d = new Date(raw);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  },

  _esc(s) {
    return (s ?? '').toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  _safeId(s) {
    return String(s || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  },
};
