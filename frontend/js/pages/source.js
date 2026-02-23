const SourcePage = {
  pollTimer: null,
  transmitters: [],
  receivers: [],

  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>SOURCE ROUTING</h1>
        <div class="subtitle">MoIP Video Distribution</div>
      </div>
      <div class="text-center" style="margin-bottom:16px;">
        <button class="btn" id="btn-refresh-routing" style="display:inline-flex;max-width:200px;">
          <span class="material-icons">refresh</span>
          <span class="btn-label">Refresh</span>
        </button>
      </div>
      <div id="routing-container">
        <div class="text-center" style="opacity:0.5;">Loading receiver mappings...</div>
      </div>
    `;
  },

  init() {
    // Load device config
    if (App.devicesConfig?.moip) {
      this.transmitters = App.devicesConfig.moip.transmitters || [];
      this.receivers = App.devicesConfig.moip.receivers || [];
    }

    this.loadRouting();
    this.pollTimer = setInterval(() => this.loadRouting(), 10000);

    document.getElementById('btn-refresh-routing')?.addEventListener('click', () => this.loadRouting());
  },

  async loadRouting() {
    const state = await MoIPAPI.poll();
    const container = document.getElementById('routing-container');
    if (!container) return;

    if (!this.receivers.length) {
      container.innerHTML = '<div class="text-center" style="color:#cc0000;">No receivers configured. Check device configuration.</div>';
      return;
    }

    // Group receivers by location
    const groups = {};
    this.receivers.forEach(rx => {
      const loc = rx.location || 'Other';
      if (!groups[loc]) groups[loc] = [];
      groups[loc].push(rx);
    });

    let html = '';
    for (const [location, rxList] of Object.entries(groups)) {
      html += `<div class="control-section"><div class="section-title">${location}</div><div class="routing-grid">`;
      rxList.forEach(rx => {
        const currentTx = state.receivers?.[rx.id]?.transmitter_id || '';
        const connected = state.receivers?.[rx.id]?.connected || false;
        html += `
          <div class="routing-card">
            <div class="card-title">
              <span class="material-icons" style="font-size:16px;vertical-align:middle;color:${connected ? '#00b050' : '#666'};">
                ${connected ? 'link' : 'link_off'}
              </span>
              RX ${rx.id} - ${rx.name}
            </div>
            <select class="routing-select" data-rx="${rx.id}">
              <option value="">-- Select Source --</option>
              ${this.transmitters.map(tx => `<option value="${tx.id}" ${String(currentTx) === String(tx.id) ? 'selected' : ''}>${tx.id} - ${tx.name}</option>`).join('')}
            </select>
          </div>
        `;
      });
      html += '</div></div>';
    }
    container.innerHTML = html;

    // Attach change handlers
    container.querySelectorAll('.routing-select').forEach(sel => {
      sel.addEventListener('change', async (e) => {
        const rxId = e.target.dataset.rx;
        const txId = e.target.value;
        if (txId) {
          await MoIPAPI.switchSource(txId, rxId);
          App.showToast(`RX ${rxId} → TX ${txId}`);
        }
      });
    });
  },

  destroy() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
};
