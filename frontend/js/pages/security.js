const SecurityPage = {
  cameras: [],

  render(container) {
    const cameraEntries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];

    container.innerHTML = `
      <div class="page-header">
        <h1>SECURITY</h1>
        <div class="subtitle">Camera Overview</div>
      </div>
      <div class="camera-grid">
        ${cameraEntries.map(([key, cam]) => `
          <div class="camera-card">
            <div class="camera-header">${key.replace(/_/g, ' ')}</div>
            <div class="camera-feed" id="feed-${key}">
              <span class="material-icons" style="font-size:48px;opacity:0.3;">videocam</span>
              <div style="font-size:12px;opacity:0.4;margin-top:8px;">${cam.ip || cam.name}</div>
            </div>
            <div class="camera-controls">
              <button class="btn" data-cam="${key}" data-ptz-action="preset" data-val="1" style="min-height:36px;padding:4px 8px;"><span class="btn-label">P1</span></button>
              <button class="btn" data-cam="${key}" data-ptz-action="preset" data-val="2" style="min-height:36px;padding:4px 8px;"><span class="btn-label">P2</span></button>
              <button class="btn" data-cam="${key}" data-ptz-action="preset" data-val="3" style="min-height:36px;padding:4px 8px;"><span class="btn-label">P3</span></button>
              <button class="btn" data-cam="${key}" data-ptz-action="home" style="min-height:36px;padding:4px 8px;"><span class="material-icons" style="font-size:16px;">home</span></button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="text-center mt-16">
        <button class="btn" id="btn-security-grid" style="display:inline-flex;max-width:300px;">
          <span class="material-icons">grid_view</span>
          <span class="btn-label">View Security Grid on Displays</span>
        </button>
      </div>
    `;
  },

  init() {
    // PTZ actions
    document.querySelectorAll('[data-cam]').forEach(btn => {
      btn.addEventListener('click', () => {
        const camKey = btn.dataset.cam;
        const action = btn.dataset.ptzAction;
        if (action === 'preset') {
          PtzAPI.callPreset(camKey, btn.dataset.val);
        } else if (action === 'home') {
          PtzAPI.home(camKey);
        }
      });
    });

    document.getElementById('btn-security-grid')?.addEventListener('click', async () => {
      // Route security grid transmitter to lobby displays
      await MoIPAPI.switchSource('4', '11');
      await MoIPAPI.switchSource('4', '12');
      await MoIPAPI.switchSource('4', '13');
      App.showToast('Security grid sent to lobby displays');
    });
  },
  destroy() {}
};
