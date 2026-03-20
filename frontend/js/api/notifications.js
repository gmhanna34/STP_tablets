// Notification Center — collects macro results, shows bell badge + slide-out panel
const NotificationCenter = {
  _items: [],       // {id, timestamp, label, type, message, details, read}
  _maxItems: 50,
  _panel: null,
  _open: false,

  init() {
    this._panel = document.getElementById('notif-panel');
    const bell = document.getElementById('notif-bell');
    const overlay = document.getElementById('notif-overlay');
    const clearBtn = document.getElementById('notif-clear');

    if (bell) bell.addEventListener('click', () => this.toggle());
    if (overlay) overlay.addEventListener('click', () => this.close());
    if (clearBtn) clearBtn.addEventListener('click', () => this.clearAll());

    // Event delegation for retry buttons
    const list = document.getElementById('notif-list');
    if (list) {
      list.addEventListener('click', (e) => {
        const retryBtn = e.target.closest('.notif-retry-btn');
        if (!retryBtn) return;
        const macroKey = retryBtn.dataset.macro;
        if (!macroKey || typeof MacroAPI === 'undefined') return;
        retryBtn.disabled = true;
        retryBtn.textContent = 'Retrying…';
        MacroAPI.execute(macroKey);
      });
    }
  },

  // ── Public API ──────────────────────────────────────────────────────

  /** Add a notification. type: 'success' | 'warning' | 'error' */
  add(label, type, message, details) {
    const item = {
      id: Date.now() + Math.random(),
      timestamp: new Date(),
      label,
      type,
      message,
      details: details || null,
      read: false,
    };
    this._items.unshift(item);
    if (this._items.length > this._maxItems) this._items.pop();
    this._updateBadge();
    if (this._open) this._renderList();
    return item;
  },

  /** Show a macro completion notification. Called from macro:progress handler. */
  addMacroResult(data) {
    const { label, status, steps_completed, steps_total, error } = data;
    if (status === 'completed') {
      this.add(label, 'success', `Completed (${steps_completed}/${steps_total} steps)`);
    } else if (status === 'failed') {
      const item = this.add(label, 'error', error || 'Unknown error', this._buildStepDetails(data));
      if (data.macro) {
        item.macro_key = data.macro;
        item.retryable = true;
      }
    }
    // 'warning' type is handled by the caller for partial skips — see below
  },

  /** Add a warning for macros with skipped/failed steps that still "completed". */
  addMacroWarning(label, issueCount, details) {
    this.add(label, 'warning', `${issueCount} issue${issueCount !== 1 ? 's' : ''}`, details);
  },

  toggle() {
    if (this._open) this.close(); else this.open();
  },

  open() {
    this._open = true;
    this._panel?.classList.add('notif-panel-open');
    document.getElementById('notif-overlay')?.classList.remove('hidden');
    // Mark all as read
    this._items.forEach(i => { i.read = true; });
    this._updateBadge();
    this._renderList();
  },

  close() {
    this._open = false;
    this._panel?.classList.remove('notif-panel-open');
    document.getElementById('notif-overlay')?.classList.add('hidden');
  },

  clearAll() {
    this._items = [];
    this._updateBadge();
    this._renderList();
  },

  /** Get unread count */
  get unreadCount() {
    return this._items.filter(i => !i.read).length;
  },

  // ── Internal ────────────────────────────────────────────────────────

  _updateBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    const count = this.unreadCount;
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('hidden', count === 0);

    // Pulse the bell when there are unread warnings/errors
    const bell = document.getElementById('notif-bell');
    if (bell) {
      const hasUrgent = this._items.some(i => !i.read && (i.type === 'warning' || i.type === 'error'));
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
      const time = item.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const detailsHtml = item.details
        ? `<div class="notif-details">${this._esc(item.details)}</div>`
        : '';
      const retryHtml = item.retryable && item.macro_key
        ? `<button class="notif-retry-btn" data-macro="${this._esc(item.macro_key)}">Retry</button>`
        : '';
      return `<div class="notif-item notif-item-${item.type}">
        <span class="material-icons notif-icon">${icon}</span>
        <div class="notif-content">
          <div class="notif-item-header">
            <strong>${this._esc(item.label)}</strong>
            <span class="notif-time">${time}</span>
          </div>
          <div class="notif-message">${this._esc(item.message)}</div>
          ${detailsHtml}
          ${retryHtml}
        </div>
      </div>`;
    }).join('');
  },

  _esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _buildStepDetails(data) {
    if (data.error) return data.error;
    return null;
  },
};
