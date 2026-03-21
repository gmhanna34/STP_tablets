// Notification Center — server-persisted notifications with per-tablet dismiss
const NotificationCenter = {
  _items: [],       // {id, created_at, label, type, message, details, source, macro_key}
  _panel: null,
  _open: false,
  _seenIds: new Set(),  // track IDs we've already seen (for badge counting)

  init() {
    this._panel = document.getElementById('notif-panel');
    const bell = document.getElementById('notif-bell');
    const overlay = document.getElementById('notif-overlay');
    const clearBtn = document.getElementById('notif-clear');

    if (bell) bell.addEventListener('click', () => this.toggle());
    if (overlay) overlay.addEventListener('click', () => this.close());
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearAll());

    // Event delegation for retry and dismiss buttons
    const list = document.getElementById('notif-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const retryBtn = e.target.closest('.notif-retry-btn');
        if (retryBtn) {
          const macroKey = retryBtn.dataset.macro;
          if (!macroKey || typeof MacroAPI === 'undefined') return;
          retryBtn.disabled = true;
          retryBtn.textContent = 'Retrying…';
          MacroAPI.execute(macroKey);
          return;
        }
        const dismissBtn = e.target.closest('.notif-dismiss-btn');
        if (dismissBtn) {
          const nid = parseInt(dismissBtn.dataset.id, 10);
          this.dismiss(nid);
        }
      });
    }

    // Listen for real-time notifications from server
    if (typeof App !== 'undefined' && App.socket) {
      this._bindSocket(App.socket);
    }

    // Load persisted notifications from server
    this._fetchFromServer();
  },

  _socketBound: false,

  _bindSocket(socket) {
    if (this._socketBound) return;
    this._socketBound = true;
    socket.on('notification:new', (item) => {
      if (!item || !item.id) return;
      // Avoid duplicates
      if (this._items.some(i => i.id === item.id)) return;
      this._items.unshift(item);
      this._updateBadge();
      if (this._open) this._renderList();
    });
  },

  // ── Public API ──────────────────────────────────────────────────────

  /** Called from macro:progress — now server-persisted, just show toast feedback */
  addMacroResult(_data) {
    // Server creates the notification; real-time arrives via notification:new
  },

  /** Called from macro_verify_failed — now server-persisted */
  addMacroWarning(_label, _issueCount, _details) {
    // Server creates the notification; real-time arrives via notification:new
  },

  /** Legacy add for HA failures — now server-persisted */
  add(_label, _type, _message, _details) {
    // Server creates the notification; real-time arrives via notification:new
  },

  toggle() {
    if (this._open) this.close(); else this.open();
  },

  open() {
    this._open = true;
    this._panel?.classList.add('notif-panel-open');
    document.getElementById('notif-overlay')?.classList.remove('hidden');
    // Mark all current items as "seen" (no longer count as new)
    this._items.forEach(i => this._seenIds.add(i.id));
    this._updateBadge();
    this._renderList();
  },

  close() {
    this._open = false;
    this._panel?.classList.remove('notif-panel-open');
    document.getElementById('notif-overlay')?.classList.add('hidden');
  },

  dismiss(nid) {
    this._items = this._items.filter(i => i.id !== nid);
    this._seenIds.add(nid);
    this._updateBadge();
    this._renderList();
    fetch('/api/notifications/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: nid }),
    }).catch(() => {});
  },

  clearAll() {
    this._items.forEach(i => this._seenIds.add(i.id));
    this._items = [];
    this._updateBadge();
    this._renderList();
    fetch('/api/notifications/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'all' }),
    }).catch(() => {});
  },

  /** Get count of items not yet seen by this tablet */
  get unreadCount() {
    return this._items.filter(i => !this._seenIds.has(i.id)).length;
  },

  // ── Internal ────────────────────────────────────────────────────────

  _fetchFromServer() {
    fetch('/api/notifications')
      .then(r => r.json())
      .then(items => {
        if (!Array.isArray(items)) return;
        this._items = items;
        this._updateBadge();
        if (this._open) this._renderList();
      })
      .catch(() => {});
  },

  _updateBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    const count = this.unreadCount;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('hidden', count === 0);

    // Pulse the bell when there are unseen warnings/errors
    const bell = document.getElementById('notif-bell');
    if (bell) {
      const hasUrgent = this._items.some(i =>
        !this._seenIds.has(i.id) && (i.type === 'warning' || i.type === 'error'));
      bell.classList.toggle('notif-bell-pulse', hasUrgent);
    }
  },

  _renderList() {
    const list = document.getElementById('notif-list');
    if (!list) return;

    if (!this._items.length) {
      list.innerHTML = '<div class="notif-empty">No notifications</div>';
      return;
    }

    list.innerHTML = this._items.map(item => {
      const icon = item.type === 'error' ? 'error' : item.type === 'warning' ? 'warning' : 'check_circle';
      const ts = item.created_at ? new Date(item.created_at + 'Z') : new Date();
      const time = ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const detailsHtml = item.details
        ? `<div class="notif-details">${this._esc(item.details)}</div>`
        : '';
      const retryHtml = item.macro_key
        ? `<button class="notif-retry-btn" data-macro="${this._esc(item.macro_key)}">Retry</button>`
        : '';
      const sourceHtml = item.source
        ? `<span class="notif-source">${this._esc(this._formatSource(item.source))}</span>`
        : '';
      return `<div class="notif-item notif-item-${item.type}">
        <span class="material-icons notif-icon">${icon}</span>
        <div class="notif-content">
          <div class="notif-item-header">
            <strong>${this._esc(item.label)}</strong>
            <div class="notif-meta">
              ${sourceHtml}
              <span class="notif-time">${time}</span>
              <button class="notif-dismiss-btn" data-id="${item.id}" title="Dismiss">
                <span class="material-icons" style="font-size:16px;">close</span>
              </button>
            </div>
          </div>
          <div class="notif-message">${this._esc(item.message)}</div>
          ${detailsHtml}
          ${retryHtml}
        </div>
      </div>`;
    }).join('');
  },

  _formatSource(source) {
    if (!source || source === 'Unknown') return '';
    if (source.startsWith('user:')) return source.substring(5);
    // Capitalize tablet ID: "chapel" → "Chapel"
    return source.charAt(0).toUpperCase() + source.slice(1);
  },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
};
