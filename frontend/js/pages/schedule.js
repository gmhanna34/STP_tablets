// Schedule Page — Calendar-driven event automation dashboard
// Shows upcoming church services with auto-setup/teardown status, preflight checks,
// and manual override controls.

const SchedulePage = {
  _pollTimer: null,
  _events: [],
  _profiles: {},
  _status: {},

  render(container) {
    container.innerHTML = `
      <div class="schedule-page">
        <div class="schedule-header">
          <div class="schedule-header-left">
            <h1 class="schedule-title">Event Automation</h1>
            <div class="schedule-subtitle">
              Calendar-driven setup &amp; teardown &middot; <span id="schedule-feed-status">Loading...</span>
            </div>
          </div>
          <div class="schedule-header-right">
            <button class="btn-action" id="schedule-refresh-btn" title="Refresh calendar feed">
              <span class="material-icons">refresh</span>
            </button>
          </div>
        </div>

        <div class="schedule-status-bar" id="schedule-status-bar"></div>

        <div class="schedule-timeline" id="schedule-timeline">
          <div class="schedule-loading">Loading events...</div>
        </div>
      </div>

      <!-- Event Detail Modal -->
      <div id="schedule-modal-overlay" class="overlay hidden">
        <div class="modal schedule-modal">
          <div class="modal-header-bar">
            <h2 id="schedule-modal-title">Event Details</h2>
            <button class="modal-close" id="schedule-modal-close">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div class="modal-body" id="schedule-modal-body"></div>
        </div>
      </div>
    `;
  },

  async init() {
    this._bindEvents();
    await this._loadAll();
    this._pollTimer = setInterval(() => this._loadEvents(), 15000);
  },

  destroy() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  },

  _bindEvents() {
    const refreshBtn = document.getElementById('schedule-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', async () => {
        refreshBtn.disabled = true;
        try {
          await fetch('/api/event-automation/refresh', { method: 'POST' });
          await this._loadEvents();
          App.showToast('Calendar refreshed', 2000);
        } catch (e) {
          App.showToast('Refresh failed', 2000, 'error');
        }
        refreshBtn.disabled = false;
      });
    }

    const closeBtn = document.getElementById('schedule-modal-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this._closeModal());
    }
    const overlay = document.getElementById('schedule-modal-overlay');
    if (overlay) {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this._closeModal();
      });
    }
  },

  async _loadAll() {
    await Promise.all([this._loadProfiles(), this._loadStatus(), this._loadEvents()]);
  },

  async _loadProfiles() {
    try {
      const resp = await fetch('/api/event-automation/profiles');
      if (resp.ok) this._profiles = await resp.json();
    } catch (e) {
      console.error('Failed to load profiles:', e);
    }
  },

  async _loadStatus() {
    try {
      const resp = await fetch('/api/event-automation/status');
      if (resp.ok) {
        this._status = await resp.json();
        this._updateStatusBar();
      }
    } catch (e) {
      console.error('Failed to load status:', e);
    }
  },

  async _loadEvents() {
    try {
      const resp = await fetch('/api/event-automation/events?hours=72');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._events = await resp.json();
      this._renderTimeline();
      this._updateFeedStatus();
    } catch (e) {
      console.error('Failed to load events:', e);
      const tl = document.getElementById('schedule-timeline');
      if (tl) tl.innerHTML = '<div class="schedule-loading">Failed to load events</div>';
    }
  },

  _updateStatusBar() {
    const bar = document.getElementById('schedule-status-bar');
    if (!bar) return;
    const s = this._status;
    if (!s.enabled) {
      bar.innerHTML = `<div class="schedule-status-chip schedule-status-disabled">
        <span class="material-icons">power_off</span> Automation Disabled
      </div>`;
      return;
    }
    bar.innerHTML = `
      <div class="schedule-status-chip schedule-status-ok">
        <span class="material-icons">event_available</span>
        ${s.upcoming_events || 0} upcoming
      </div>
      <div class="schedule-status-chip">
        <span class="material-icons">timer</span>
        Setup ${s.setup_lead_minutes || 30}m before
      </div>
      <div class="schedule-status-chip">
        <span class="material-icons">timer_off</span>
        Teardown ${s.teardown_delay_minutes || 15}m after
      </div>
      <div class="schedule-status-chip">
        <span class="material-icons">category</span>
        ${s.profiles_count || 0} profiles
      </div>
    `;
  },

  _updateFeedStatus() {
    const el = document.getElementById('schedule-feed-status');
    if (!el) return;
    const s = this._status;
    if (s.feed_ok) {
      el.textContent = `Feed OK \u2022 ${this._events.length} events loaded`;
      el.style.color = 'var(--ok)';
    } else if (s.enabled === false) {
      el.textContent = 'Automation disabled';
      el.style.color = 'var(--text-secondary)';
    } else {
      el.textContent = 'Calendar feed unavailable';
      el.style.color = 'var(--warn)';
    }
  },

  _renderTimeline() {
    const tl = document.getElementById('schedule-timeline');
    if (!tl) return;

    if (this._events.length === 0) {
      tl.innerHTML = '<div class="schedule-loading">No upcoming events found in calendar</div>';
      return;
    }

    // Group events by date
    const groups = {};
    for (const ev of this._events) {
      const date = ev.start.split('T')[0];
      if (!groups[date]) groups[date] = [];
      groups[date].push(ev);
    }

    let html = '';
    for (const [date, events] of Object.entries(groups)) {
      const dateObj = new Date(date + 'T12:00:00');
      const dayLabel = this._formatDate(dateObj);
      const isToday = date === new Date().toISOString().split('T')[0];

      html += `<div class="schedule-day-group${isToday ? ' schedule-today' : ''}">
        <div class="schedule-day-header">
          <span class="schedule-day-label">${dayLabel}</span>
          ${isToday ? '<span class="schedule-today-badge">TODAY</span>' : ''}
        </div>`;

      for (const ev of events) {
        html += this._renderEventCard(ev);
      }
      html += '</div>';
    }

    tl.innerHTML = html;

    // Bind card click handlers
    tl.querySelectorAll('.schedule-event-card').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.eventKey;
        const ev = this._events.find(e => e.key === key);
        if (ev) this._openEventModal(ev);
      });
    });
  },

  _renderEventCard(ev) {
    const startTime = this._formatTime(ev.start);
    const endTime = this._formatTime(ev.end);
    const statusClass = this._statusClass(ev.status);
    const statusLabel = this._statusLabel(ev.status);
    const statusIcon = this._statusIcon(ev.status);

    const preflightHtml = ev.preflight_result
      ? `<span class="schedule-preflight-badge ${ev.preflight_result.all_ok ? 'preflight-ok' : 'preflight-warn'}">
           <span class="material-icons" style="font-size:14px;">${ev.preflight_result.all_ok ? 'check_circle' : 'warning'}</span>
           Preflight ${ev.preflight_result.all_ok ? 'OK' : 'Warning'}
         </span>`
      : '';

    return `
      <div class="schedule-event-card ${statusClass}" data-event-key="${this._esc(ev.key)}">
        <div class="schedule-event-time">
          <span class="schedule-time-start">${startTime}</span>
          <span class="schedule-time-sep">&ndash;</span>
          <span class="schedule-time-end">${endTime}</span>
        </div>
        <div class="schedule-event-info">
          <div class="schedule-event-title">${this._esc(ev.title)}</div>
          <div class="schedule-event-profile">
            <span class="material-icons" style="font-size:14px;">smart_toy</span>
            ${this._esc(ev.profile_label)}
          </div>
        </div>
        <div class="schedule-event-status">
          <span class="schedule-status-badge ${statusClass}">
            <span class="material-icons" style="font-size:16px;">${statusIcon}</span>
            ${statusLabel}
          </span>
          ${preflightHtml}
        </div>
      </div>
    `;
  },

  _openEventModal(ev) {
    const overlay = document.getElementById('schedule-modal-overlay');
    const title = document.getElementById('schedule-modal-title');
    const body = document.getElementById('schedule-modal-body');
    if (!overlay || !title || !body) return;

    title.textContent = ev.title;

    const profileOptions = Object.entries(this._profiles)
      .map(([id, p]) => `<option value="${id}" ${id === ev.profile_id ? 'selected' : ''}>${this._esc(p.label)}</option>`)
      .join('');

    body.innerHTML = `
      <div class="schedule-detail-grid">
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Time</span>
          <span class="schedule-detail-value">${this._formatTime(ev.start)} \u2013 ${this._formatTime(ev.end)}</span>
        </div>
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Date</span>
          <span class="schedule-detail-value">${this._formatDate(new Date(ev.start))}</span>
        </div>
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Status</span>
          <span class="schedule-detail-value">
            <span class="schedule-status-badge ${this._statusClass(ev.status)}">
              <span class="material-icons" style="font-size:16px;">${this._statusIcon(ev.status)}</span>
              ${this._statusLabel(ev.status)}
            </span>
          </span>
        </div>
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Setup Time</span>
          <span class="schedule-detail-value">${this._formatTime(ev.setup_time)}</span>
        </div>
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Teardown Time</span>
          <span class="schedule-detail-value">${this._formatTime(ev.teardown_time)}</span>
        </div>
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Setup Macro</span>
          <span class="schedule-detail-value"><code>${this._esc(ev.setup_macro || 'none')}</code></span>
        </div>
        <div class="schedule-detail-row">
          <span class="schedule-detail-label">Teardown Macro</span>
          <span class="schedule-detail-value"><code>${this._esc(ev.teardown_macro || 'none')}</code></span>
        </div>

        <div class="schedule-detail-section">
          <span class="schedule-detail-label">Profile</span>
          <select class="schedule-profile-select" id="schedule-profile-select">
            <option value="">Auto-detect</option>
            ${profileOptions}
          </select>
        </div>

        ${ev.preflight_result ? this._renderPreflightDetails(ev.preflight_result) : ''}

        <div class="schedule-detail-actions">
          ${ev.status !== 'skipped'
            ? `<button class="btn-action schedule-btn-skip" id="schedule-btn-skip">
                 <span class="material-icons">block</span> Skip Event
               </button>`
            : `<button class="btn-action schedule-btn-unskip" id="schedule-btn-unskip">
                 <span class="material-icons">undo</span> Resume Automation
               </button>`
          }
          <button class="btn-action schedule-btn-setup" id="schedule-btn-trigger-setup">
            <span class="material-icons">play_arrow</span> Run Setup Now
          </button>
          <button class="btn-action schedule-btn-teardown" id="schedule-btn-trigger-teardown">
            <span class="material-icons">stop</span> Run Teardown Now
          </button>
          <button class="btn-action schedule-btn-preflight" id="schedule-btn-preflight">
            <span class="material-icons">fact_check</span> Run Preflight
          </button>
        </div>
      </div>
    `;

    // Bind modal actions
    const skipBtn = document.getElementById('schedule-btn-skip');
    if (skipBtn) skipBtn.addEventListener('click', () => this._skipEvent(ev.key));

    const unskipBtn = document.getElementById('schedule-btn-unskip');
    if (unskipBtn) unskipBtn.addEventListener('click', () => this._unskipEvent(ev.key));

    const setupBtn = document.getElementById('schedule-btn-trigger-setup');
    if (setupBtn) setupBtn.addEventListener('click', () => this._triggerAction(ev.key, 'setup'));

    const teardownBtn = document.getElementById('schedule-btn-trigger-teardown');
    if (teardownBtn) teardownBtn.addEventListener('click', () => this._triggerAction(ev.key, 'teardown'));

    const preflightBtn = document.getElementById('schedule-btn-preflight');
    if (preflightBtn) preflightBtn.addEventListener('click', () => this._runPreflight(ev.key));

    const profileSelect = document.getElementById('schedule-profile-select');
    if (profileSelect) {
      profileSelect.addEventListener('change', () => this._overrideProfile(ev.key, profileSelect.value));
    }

    overlay.classList.remove('hidden');
  },

  _renderPreflightDetails(preflight) {
    const checks = preflight.checks || {};
    let rows = '';
    for (const [id, check] of Object.entries(checks)) {
      const icon = check.level === 'ok' ? 'check_circle' : check.level === 'warning' ? 'warning' : 'error';
      const color = check.level === 'ok' ? 'var(--ok)' : check.level === 'warning' ? 'var(--warn)' : 'var(--down)';
      rows += `<div class="schedule-preflight-row">
        <span class="material-icons" style="font-size:16px;color:${color};">${icon}</span>
        <span>${this._esc(check.name || id)}</span>
        <span style="color:var(--text-secondary);font-size:0.85em;">${this._esc(check.message || '')}</span>
      </div>`;
    }
    return `
      <div class="schedule-detail-section">
        <span class="schedule-detail-label">Preflight Results</span>
        <div class="schedule-preflight-list">${rows}</div>
        <span style="font-size:0.8em;color:var(--text-secondary);">
          Checked at ${this._formatTime(preflight.timestamp)}
        </span>
      </div>
    `;
  },

  _closeModal() {
    const overlay = document.getElementById('schedule-modal-overlay');
    if (overlay) overlay.classList.add('hidden');
  },

  async _skipEvent(key) {
    try {
      await fetch(`/api/event-automation/events/${encodeURIComponent(key)}/skip`, { method: 'POST' });
      App.showToast('Event skipped', 2000);
      this._closeModal();
      await this._loadEvents();
    } catch (e) {
      App.showToast('Failed to skip event', 2000, 'error');
    }
  },

  async _unskipEvent(key) {
    try {
      await fetch(`/api/event-automation/events/${encodeURIComponent(key)}/unskip`, { method: 'POST' });
      App.showToast('Automation resumed', 2000);
      this._closeModal();
      await this._loadEvents();
    } catch (e) {
      App.showToast('Failed to resume', 2000, 'error');
    }
  },

  async _triggerAction(key, action) {
    try {
      const resp = await fetch(`/api/event-automation/events/${encodeURIComponent(key)}/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await resp.json();
      if (data.success) {
        App.showToast(`${action === 'setup' ? 'Setup' : 'Teardown'} triggered`, 2000);
        this._closeModal();
        await this._loadEvents();
      } else {
        App.showToast(data.error || 'Failed', 3000, 'error');
      }
    } catch (e) {
      App.showToast('Failed to trigger action', 2000, 'error');
    }
  },

  async _runPreflight(key) {
    try {
      App.showToast('Running preflight checks...', 2000);
      await fetch(`/api/event-automation/events/${encodeURIComponent(key)}/preflight`, { method: 'POST' });
      await this._loadEvents();
      // Re-open modal with updated data
      const ev = this._events.find(e => e.key === key);
      if (ev) {
        this._closeModal();
        this._openEventModal(ev);
      }
      App.showToast('Preflight complete', 2000);
    } catch (e) {
      App.showToast('Preflight failed', 2000, 'error');
    }
  },

  async _overrideProfile(key, profileId) {
    try {
      await fetch(`/api/event-automation/events/${encodeURIComponent(key)}/override-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileId }),
      });
      App.showToast(profileId ? 'Profile overridden' : 'Profile reset to auto', 2000);
      await this._loadEvents();
    } catch (e) {
      App.showToast('Failed to change profile', 2000, 'error');
    }
  },

  // --- Formatting helpers ---

  _formatTime(isoStr) {
    if (!isoStr) return '--:--';
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  },

  _formatDate(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  },

  _statusClass(status) {
    const map = {
      upcoming: 'schedule-ev-upcoming',
      preflight: 'schedule-ev-preflight',
      ready: 'schedule-ev-ready',
      active: 'schedule-ev-active',
      completed: 'schedule-ev-completed',
      skipped: 'schedule-ev-skipped',
    };
    return map[status] || 'schedule-ev-upcoming';
  },

  _statusLabel(status) {
    const map = {
      upcoming: 'Upcoming',
      preflight: 'Preflight',
      ready: 'Ready',
      active: 'Setup Complete',
      completed: 'Done',
      skipped: 'Skipped',
    };
    return map[status] || status;
  },

  _statusIcon(status) {
    const map = {
      upcoming: 'schedule',
      preflight: 'fact_check',
      ready: 'play_circle',
      active: 'check_circle',
      completed: 'task_alt',
      skipped: 'block',
    };
    return map[status] || 'schedule';
  },

  _esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
