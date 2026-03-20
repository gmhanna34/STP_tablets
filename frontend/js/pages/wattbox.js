// WattBox Device Browser — PDU and outlet state management
const WattBoxPage = {
  _data: {},        // pdu_id -> device state
  _pollTimer: null,
  _expanded: new Set(),

  _version: '26-087',  // page version for cache debugging

  render(container) {
    console.log(`[WattBox] render() — page version ${this._version}`);
    container.innerHTML = `
      <div class="wattbox-page">
        <div class="wattbox-header">
          <h1>
            <span class="material-icons" style="vertical-align:middle;margin-right:8px;">electrical_services</span>
            WattBox Power Distribution
          </h1>
          <div id="wb-summary" class="wb-summary"></div>
        </div>
        <div id="wb-grid" class="wb-grid">
          <div class="wb-loading">Loading WattBox devices...</div>
        </div>
        <div style="text-align:right;font-size:10px;opacity:0.3;margin-top:8px;">wb ${this._version}</div>
      </div>
    `;
  },

  async init() {
    await this._loadData();
    this._pollTimer = App.registerTimer(() => this._refresh(), 5000);

    // Join wattbox Socket.IO room for real-time updates
    if (App.socket && App.socket.connected) {
      App.socket.emit('join', { room: 'wattbox' });
    }
  },

  destroy() {
    this._pollTimer = null;
  },

  // Called by App when state:wattbox Socket.IO event arrives
  onStateUpdate(data) {
    if (!data) return;
    for (const [pduId, pduState] of Object.entries(data)) {
      this._data[pduId] = pduState;
    }
    this._renderGrid();
  },

  async _loadData() {
    try {
      const resp = await fetch('/api/wattbox/devices');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._data = await resp.json();
    } catch (e) {
      console.error('WattBox load failed:', e);
      this._data = {};
    }
    this._renderGrid();
  },

  async _refresh() {
    try {
      const resp = await fetch('/api/wattbox/devices');
      if (!resp.ok) return;
      this._data = await resp.json();
      this._renderGrid();
    } catch { /* silent — poll will retry */ }
  },

  _renderGrid() {
    const grid = document.getElementById('wb-grid');
    const summary = document.getElementById('wb-summary');
    if (!grid) return;

    const pdus = Object.entries(this._data);
    if (pdus.length === 0) {
      grid.innerHTML = `
        <div class="wb-empty">
          <span class="material-icons" style="font-size:48px;opacity:0.3;">power_off</span>
          <p>No WattBox devices available</p>
          <p style="font-size:12px;opacity:0.5;">Check that the WattBox module is running</p>
        </div>
      `;
      if (summary) summary.innerHTML = '';
      return;
    }

    // Summary
    const total = pdus.length;
    const connected = pdus.filter(([, d]) => d.connected).length;
    const offline = total - connected;
    if (summary) {
      summary.innerHTML = `
        <span class="wb-pill wb-pill-ok">${connected} Connected</span>
        ${offline > 0 ? `<span class="wb-pill wb-pill-down">${offline} Offline</span>` : ''}
      `;
    }

    // PDU cards — using onclick attributes for bulletproof click handling
    grid.innerHTML = pdus.map(([pduId, dev]) => {
      const expanded = this._expanded.has(pduId);
      const outlets = dev.outlets || {};
      const outletEntries = Object.entries(outlets).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
      const onCount = outletEntries.filter(([, o]) => o.state === 'on').length;
      const offCount = outletEntries.length - onCount;

      return `
        <div class="wb-card ${dev.connected ? '' : 'wb-card-offline'}">
          <div class="wb-card-header" onclick="WattBoxPage._toggleExpand('${this._escAttr(pduId)}')">
            <div class="wb-card-status">
              <span class="wb-dot ${dev.connected ? 'wb-dot-ok' : 'wb-dot-down'}"></span>
              <strong>${this._esc(dev.label || pduId)}</strong>
            </div>
            <div class="wb-card-meta">
              ${dev.model ? `<span class="wb-meta-tag">${this._esc(dev.model)}</span>` : ''}
              ${dev.voltage ? `<span class="wb-meta-tag">${dev.voltage}V</span>` : ''}
              ${dev.current != null ? `<span class="wb-meta-tag">${dev.current}A</span>` : ''}
              <span class="wb-outlet-counts">${onCount} on / ${offCount} off</span>
              <span class="material-icons wb-expand-icon">${expanded ? 'expand_less' : 'expand_more'}</span>
            </div>
          </div>
          <div class="wb-card-ip">${this._esc(dev.ip)}</div>
          <div class="wb-outlet-list ${expanded ? '' : 'hidden'}" id="wb-outlets-${this._escAttr(pduId)}">
            ${outletEntries.map(([num, outlet]) => `
              <div class="wb-outlet-row">
                <div class="wb-outlet-info">
                  <span class="wb-outlet-num">#${num}</span>
                  <span class="wb-outlet-name">${this._esc(outlet.name || 'Outlet ' + num)}</span>
                </div>
                <div class="wb-outlet-controls">
                  <span class="wb-outlet-state wb-outlet-${outlet.state}">${outlet.state.toUpperCase()}</span>
                  <button class="wb-toggle-btn ${outlet.state === 'on' ? 'wb-btn-off' : 'wb-btn-on'}"
                          onclick="WattBoxPage._onToggle(this, '${this._escAttr(outlet.stable_id)}', '${outlet.state === 'on' ? 'off' : 'on'}'); event.stopPropagation();"
                          ${!dev.connected ? 'disabled' : ''}>
                    <span class="material-icons">${outlet.state === 'on' ? 'power_settings_new' : 'power'}</span>
                    ${outlet.state === 'on' ? 'OFF' : 'ON'}
                  </button>
                  <button class="wb-toggle-btn wb-btn-cycle"
                          onclick="WattBoxPage._onToggle(this, '${this._escAttr(outlet.stable_id)}', 'cycle'); event.stopPropagation();"
                          ${!dev.connected ? 'disabled' : ''}
                          title="Power cycle (off then on)">
                    <span class="material-icons">refresh</span>
                  </button>
                </div>
              </div>
            `).join('')}
            ${dev.connected ? `
              <div class="wb-pdu-actions">
                <button class="wb-reboot-btn"
                        onclick="WattBoxPage._onReboot('${this._escAttr(pduId)}'); event.stopPropagation();"
                        title="Reboot PDU firmware (outlets keep power)">
                  <span class="material-icons">restart_alt</span> Reboot PDU
                </button>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  },

  // --- Click handlers called directly from onclick attributes ---

  _toggleExpand(pduId) {
    if (this._expanded.has(pduId)) {
      this._expanded.delete(pduId);
    } else {
      this._expanded.add(pduId);
    }
    this._renderGrid();
  },

  _onToggle(btn, outletId, action) {
    console.log(`[WattBox] _onToggle called: ${outletId} -> ${action}`);
    this._toggleOutlet(btn, outletId, action);
  },

  _onReboot(pduId) {
    console.log(`[WattBox] _onReboot called: ${pduId}`);
    // Find the button that was clicked
    const btn = document.querySelector(`[onclick*="_onReboot('${pduId}')"]`);
    this._rebootPdu(btn, pduId);
  },

  async _toggleOutlet(btn, outletId, action) {
    if (!outletId || !action) {
      console.error('WattBox: Missing outlet-id or action');
      return;
    }

    console.log(`WattBox: Toggling ${outletId} -> ${action}`);
    if (btn) {
      btn.disabled = true;
      btn.classList.add('wb-btn-loading');
    }

    try {
      const resp = await fetch(`/api/wattbox/${encodeURIComponent(outletId)}/power`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await resp.json();
      console.log(`WattBox: Response for ${outletId}:`, resp.status, data);
      if (!resp.ok || data.error) {
        App.showToast(data.error || `Failed to ${action} outlet`, 3000, 'error');
      } else {
        App.showToast(`${outletId}: ${action.toUpperCase()}`, 2000);
        setTimeout(() => this._refresh(), 1000);
      }
    } catch (err) {
      console.error(`WattBox: Network error toggling ${outletId}:`, err);
      App.showToast(`Network error: ${err.message}`, 3000, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('wb-btn-loading');
      }
    }
  },

  async _rebootPdu(btn, pduId) {
    const dev = this._data[pduId];
    const label = dev ? dev.label : pduId;

    const confirmed = await App.showConfirm(
      `Reboot <strong>${this._esc(label)}</strong> firmware?<br>
       <small style="opacity:0.7;">Outlets keep power. Network connection will drop for ~30 seconds.</small>`
    );
    if (!confirmed) return;

    if (btn) btn.disabled = true;
    try {
      const resp = await fetch(`/api/wattbox/pdu/${encodeURIComponent(pduId)}/reboot`, {
        method: 'POST',
      });
      const data = await resp.json();
      if (resp.ok) {
        App.showToast(`${label}: Rebooting...`, 3000);
      } else {
        App.showToast(data.error || 'Reboot failed', 3000, 'error');
      }
    } catch (err) {
      App.showToast(`Network error: ${err.message}`, 3000, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  _esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  },

  // Escape for use inside onclick attribute single-quoted strings
  _escAttr(str) {
    return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
  },
};
