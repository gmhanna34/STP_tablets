const SecurityPage = {
  _feedTimers: {},

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
              <img id="img-${key}" alt="${key}" style="width:100%;height:100%;object-fit:contain;display:none;">
              <span class="material-icons" id="placeholder-${key}" style="font-size:48px;opacity:0.3;">videocam</span>
              <div id="caption-${key}" style="font-size:12px;opacity:0.4;margin-top:8px;">${cam.ip || cam.name}</div>
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
      await MoIPAPI.switchSource('4', '11');
      await MoIPAPI.switchSource('4', '12');
      await MoIPAPI.switchSource('4', '13');
      App.showToast('Security grid sent to lobby displays');
    });

    // Start snapshot feeds for all cameras
    const cameraEntries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];
    cameraEntries.forEach(([key]) => this._startFeed(key));
  },

  _startFeed(camKey) {
    const refresh = () => {
      const img = document.getElementById(`img-${camKey}`);
      if (!img || !img.isConnected) return;  // page left

      const next = new Image();
      next.onload = () => {
        img.src = next.src;
        img.style.display = 'block';
        const ph = document.getElementById(`placeholder-${camKey}`);
        const cap = document.getElementById(`caption-${camKey}`);
        if (ph) ph.style.display = 'none';
        if (cap) cap.style.display = 'none';
        this._feedTimers[camKey] = setTimeout(refresh, 2000);
      };
      next.onerror = () => {
        this._feedTimers[camKey] = setTimeout(refresh, 5000);
      };
      next.src = `/api/ptz/${camKey}/snapshot?t=${Date.now()}`;
    };
    refresh();
  },

  destroy() {
    Object.values(this._feedTimers).forEach(t => clearTimeout(t));
    this._feedTimers = {};
  }
};
