const ConfRoomPage = {
  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>CONFERENCE ROOM</h1>
      </div>
      <div class="control-section">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
          <div>
            <div class="section-title">TV Power</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-conf-tv-on"><span class="material-icons">tv</span><span class="btn-label">TV On</span></button>
              <button class="btn btn-large" id="btn-conf-tv-off"><span class="material-icons">close</span><span class="btn-label">TV Off</span></button>
            </div>
          </div>
          <div>
            <div class="section-title">TV Input</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn" id="btn-conf-hdmi1"><span class="material-icons">settings_input_hdmi</span><span class="btn-label">HDMI 1</span></button>
              <button class="btn" id="btn-conf-hdmi2"><span class="material-icons">settings_input_hdmi</span><span class="btn-label">HDMI 2</span></button>
            </div>
          </div>
        </div>
      </div>
      <div class="control-section">
        <div class="section-title">Video Sources</div>
        <div class="control-grid">
          <button class="btn" id="btn-conf-laptop"><span class="material-icons">computer</span><span class="btn-label">Laptop</span></button>
          <button class="btn" id="btn-conf-livestream"><span class="material-icons">live_tv</span><span class="btn-label">Live Stream</span></button>
          <button class="btn" id="btn-conf-logo"><span class="material-icons">image</span><span class="btn-label">LOGO</span></button>
          <button class="btn" id="btn-conf-announcements"><span class="material-icons">announcement</span><span class="btn-label">Announcements</span></button>
        </div>
      </div>
    `;
  },
  init() {
    document.getElementById('btn-conf-tv-on')?.addEventListener('click', async () => {
      await MoIPAPI.sendIR('', '10', 'IRPowerOn');
      App.showToast('Conference Room TV On');
    });
    document.getElementById('btn-conf-tv-off')?.addEventListener('click', async () => {
      await MoIPAPI.sendIR('', '10', 'IRPowerOff');
      App.showToast('Conference Room TV Off');
    });
    document.getElementById('btn-conf-hdmi1')?.addEventListener('click', async () => {
      await MoIPAPI.sendIR('', '10', 'IRSourceHDMI1');
      App.showToast('Conference Room: HDMI 1');
    });
    document.getElementById('btn-conf-hdmi2')?.addEventListener('click', async () => {
      await MoIPAPI.sendIR('', '10', 'IRSourceHDMI2');
      App.showToast('Conference Room: HDMI 2');
    });
    document.getElementById('btn-conf-laptop')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('5', '10');
      App.showToast('Conference Room: Laptop');
    });
    document.getElementById('btn-conf-livestream')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('8', '10');
      App.showToast('Conference Room: Live Stream');
    });
    document.getElementById('btn-conf-logo')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('16', '10');
      App.showToast('Conference Room: LOGO');
    });
    document.getElementById('btn-conf-announcements')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('9', '10');
      App.showToast('Conference Room: Announcements');
    });
  },
  destroy() {}
};
