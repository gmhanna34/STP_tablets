const StreamPage = {
  pollTimer: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>LIVE STREAM</h1>
        </div>

        <!-- Status: full width, compact inline -->
        <div class="control-section">
          <div class="obs-status" id="obs-status">
            <div class="status-indicator">
              <span class="status-dot" id="dot-connection"></span>
              <span id="lbl-connection">Connecting...</span>
            </div>
            <div class="status-indicator">
              <span class="status-dot" id="dot-stream"></span>
              <span id="lbl-stream">Stream: --</span>
            </div>
            <div class="status-indicator">
              <span class="status-dot" id="dot-record"></span>
              <span id="lbl-record">Record: --</span>
            </div>
            <div class="status-indicator">
              <span style="font-size:12px;opacity:0.7;">Scene: </span>
              <span id="current-scene-name" style="font-size:14px;font-weight:bold;">--</span>
            </div>
          </div>
        </div>

        <!-- Scenes: full width -->
        <div class="control-section">
          <div class="section-title">Scenes</div>
          <div class="scene-grid" id="scene-grid">
            <div class="text-center" style="grid-column:1/-1;opacity:0.5;">Loading scenes...</div>
          </div>
        </div>

        <!-- Stream & Record: left half -->
        <div class="control-section col-span-6">
          <div class="section-title">Stream & Record</div>
          <div class="control-grid" style="grid-template-columns:repeat(2, 1fr);">
            <button class="btn" id="btn-start-stream"><span class="material-icons">play_arrow</span><span class="btn-label">Start Stream</span></button>
            <button class="btn btn-danger" id="btn-stop-stream"><span class="material-icons">stop</span><span class="btn-label">Stop Stream</span></button>
            <button class="btn" id="btn-start-record"><span class="material-icons">fiber_manual_record</span><span class="btn-label">Start Record</span></button>
            <button class="btn btn-danger" id="btn-stop-record"><span class="material-icons">stop</span><span class="btn-label">Stop Record</span></button>
          </div>
        </div>

        <!-- Slides & Advanced: right half -->
        <div class="control-section col-span-6">
          <div class="section-title">Slides & Advanced</div>
          <div class="control-grid" style="grid-template-columns:repeat(3, 1fr);">
            <button class="btn" id="btn-slides-on"><span class="material-icons">slideshow</span><span class="btn-label">Slides On</span></button>
            <button class="btn" id="btn-slides-off"><span class="material-icons">block</span><span class="btn-label">Slides Off</span></button>
            <button class="btn" id="btn-slides-toggle"><span class="material-icons">swap_horiz</span><span class="btn-label">Toggle</span></button>
            <button class="btn" id="btn-reset-stream"><span class="material-icons">restart_alt</span><span class="btn-label">Reset Stream</span></button>
            <button class="btn" id="btn-set-shure"><span class="material-icons">mic_external_on</span><span class="btn-label">Shure Mic</span></button>
            <button class="btn" id="btn-reenable-atem"><span class="material-icons">videocam</span><span class="btn-label">ATEM</span></button>
          </div>
        </div>

        <!-- Camera Controls: full width -->
        <div class="control-section">
          <div class="section-title">Camera Controls</div>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;">
            <div id="camera-preview-wrap" style="flex:1;min-width:200px;max-width:400px;">
              <div class="camera-card">
                <div class="camera-header" id="camera-label">No active camera</div>
                <div class="camera-feed" id="camera-feed">
                  <span class="material-icons">videocam</span>
                  <div style="font-size:11px;margin-top:4px;">Waiting for scene...</div>
                </div>
              </div>
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;">
              <div>
                <div class="text-center" style="margin-bottom:4px;font-size:12px;opacity:0.7;">Pan / Tilt</div>
                <div style="display:grid;grid-template-columns:repeat(3,48px);grid-template-rows:repeat(3,48px);gap:3px;">
                  <div></div>
                  <button class="btn" data-ptz="up" style="min-height:48px;"><span class="material-icons">arrow_upward</span></button>
                  <div></div>
                  <button class="btn" data-ptz="left" style="min-height:48px;"><span class="material-icons">arrow_back</span></button>
                  <button class="btn" data-ptz="home" style="min-height:48px;font-size:10px;"><span class="material-icons">home</span></button>
                  <button class="btn" data-ptz="right" style="min-height:48px;"><span class="material-icons">arrow_forward</span></button>
                  <div></div>
                  <button class="btn" data-ptz="down" style="min-height:48px;"><span class="material-icons">arrow_downward</span></button>
                  <div></div>
                </div>
              </div>
              <div>
                <div class="text-center" style="margin-bottom:4px;font-size:12px;opacity:0.7;">Zoom</div>
                <div style="display:flex;flex-direction:column;gap:4px;">
                  <button class="btn" id="btn-zoom-in" style="min-height:44px;"><span class="material-icons">zoom_in</span></button>
                  <button class="btn" id="btn-zoom-out" style="min-height:44px;"><span class="material-icons">zoom_out</span></button>
                </div>
              </div>
              <div>
                <div class="text-center" style="margin-bottom:4px;font-size:12px;opacity:0.7;">Presets</div>
                <div class="control-grid" style="grid-template-columns:repeat(3, 48px);">
                  ${[1,2,3,4,5,6,7,8,9].map(n => `<button class="btn" data-preset="${n}" style="min-height:44px;"><span class="btn-label">${n}</span></button>`).join('')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  init() {
    // Start polling OBS
    this.updateStatus();
    this.pollTimer = setInterval(() => this.updateStatus(), 3000);

    // Stream/Record buttons
    document.getElementById('btn-start-stream')?.addEventListener('click', async () => { await ObsAPI.startStream(); this.updateStatus(); });
    document.getElementById('btn-stop-stream')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Stop the live stream? This will end the broadcast for all viewers.')) return;
      await ObsAPI.stopStream();
      this.updateStatus();
    });
    document.getElementById('btn-start-record')?.addEventListener('click', async () => { await ObsAPI.startRecord(); this.updateStatus(); });
    document.getElementById('btn-stop-record')?.addEventListener('click', async () => { await ObsAPI.stopRecord(); this.updateStatus(); });

    // Slides
    document.getElementById('btn-slides-on')?.addEventListener('click', () => ObsAPI.slidesOn());
    document.getElementById('btn-slides-off')?.addEventListener('click', () => ObsAPI.slidesOff());
    document.getElementById('btn-slides-toggle')?.addEventListener('click', () => ObsAPI.toggleSlides());

    // Advanced
    document.getElementById('btn-reset-stream')?.addEventListener('click', () => ObsAPI.resetLiveStream());
    document.getElementById('btn-set-shure')?.addEventListener('click', () => ObsAPI.setAudioToShureMic());
    document.getElementById('btn-reenable-atem')?.addEventListener('click', () => ObsAPI.reEnableBMATEMWebcam());

    // PTZ controls
    document.querySelectorAll('[data-ptz]').forEach(btn => {
      const dir = btn.dataset.ptz;
      if (dir === 'home') {
        btn.addEventListener('click', () => {
          const camKey = this.getCurrentCameraKey();
          if (camKey) PtzAPI.home(camKey);
        });
      } else {
        btn.addEventListener('mousedown', () => {
          const camKey = this.getCurrentCameraKey();
          if (camKey) PtzAPI.panTilt(camKey, dir);
        });
        btn.addEventListener('mouseup', () => {
          const camKey = this.getCurrentCameraKey();
          if (camKey) PtzAPI.panTilt(camKey, 'ptzstop');
        });
        btn.addEventListener('touchstart', (e) => {
          e.preventDefault();
          const camKey = this.getCurrentCameraKey();
          if (camKey) PtzAPI.panTilt(camKey, dir);
        });
        btn.addEventListener('touchend', () => {
          const camKey = this.getCurrentCameraKey();
          if (camKey) PtzAPI.panTilt(camKey, 'ptzstop');
        });
      }
    });

    // Zoom
    const setupZoom = (btnId, fn) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('mousedown', () => { const k = this.getCurrentCameraKey(); if (k) fn(k); });
      btn.addEventListener('mouseup', () => { const k = this.getCurrentCameraKey(); if (k) PtzAPI.zoomStop(k); });
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); const k = this.getCurrentCameraKey(); if (k) fn(k); });
      btn.addEventListener('touchend', () => { const k = this.getCurrentCameraKey(); if (k) PtzAPI.zoomStop(k); });
    };
    setupZoom('btn-zoom-in', (k) => PtzAPI.zoomIn(k));
    setupZoom('btn-zoom-out', (k) => PtzAPI.zoomOut(k));

    // Presets
    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const preset = btn.dataset.preset;
        const camKey = this.getCurrentCameraKey();
        if (camKey) PtzAPI.callPreset(camKey, preset);
      });
    });

    // Camera feed preview
    this._startCameraFeed();
  },

  getCurrentCameraKey() {
    const scene = ObsAPI.state.currentScene;
    // Try to find matching camera key
    if (scene && App.settings?.ptzCameras) {
      const keys = Object.keys(App.settings.ptzCameras);
      return keys.find(k => scene.includes(k) || k === scene) || null;
    }
    return null;
  },

  // Camera feed snapshot chaining: load → wait → load next
  _activeCamKey: null,
  _feedTimeout: null,

  _startCameraFeed() {
    this._refreshCameraFeed();
  },

  _stopCameraFeed() {
    clearTimeout(this._feedTimeout);
    this._feedTimeout = null;
    this._activeCamKey = null;
  },

  _refreshCameraFeed() {
    const camKey = this.getCurrentCameraKey();
    const feedEl = document.getElementById('camera-feed');
    const labelEl = document.getElementById('camera-label');
    if (!feedEl) return;

    // No camera mapped to current scene
    if (!camKey) {
      if (this._activeCamKey) {
        feedEl.innerHTML = `<span class="material-icons">videocam</span>
          <div style="font-size:12px;margin-top:4px;">Waiting for scene...</div>`;
        this._activeCamKey = null;
      }
      if (labelEl) labelEl.textContent = 'No active camera';
      this._feedTimeout = setTimeout(() => this._refreshCameraFeed(), 2000);
      return;
    }

    // Camera changed — swap to img element
    if (camKey !== this._activeCamKey) {
      this._activeCamKey = camKey;
      const img = document.createElement('img');
      img.id = 'camera-feed-img';
      img.alt = 'Camera feed';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
      feedEl.innerHTML = '';
      feedEl.appendChild(img);
      if (labelEl) labelEl.textContent = camKey.replace(/_/g, ' ');
    }

    const img = document.getElementById('camera-feed-img');
    if (!img) return;

    const nextImg = new Image();
    nextImg.onload = () => {
      if (img.isConnected) img.src = nextImg.src;
      this._feedTimeout = setTimeout(() => this._refreshCameraFeed(), 500);
    };
    nextImg.onerror = () => {
      this._feedTimeout = setTimeout(() => this._refreshCameraFeed(), 2000);
    };
    nextImg.src = `/api/ptz/${camKey}/snapshot?t=${Date.now()}`;
  },

  async updateStatus() {
    const state = await ObsAPI.poll();

    // Connection
    const dotConn = document.getElementById('dot-connection');
    const lblConn = document.getElementById('lbl-connection');
    if (dotConn) dotConn.className = 'status-dot ' + (state.connected ? 'idle' : 'offline');
    if (lblConn) lblConn.textContent = state.connected ? 'Connected' : 'Disconnected';

    // Stream
    const dotStream = document.getElementById('dot-stream');
    const lblStream = document.getElementById('lbl-stream');
    if (dotStream) dotStream.className = 'status-dot ' + (state.streaming ? 'live' : 'idle');
    if (lblStream) lblStream.textContent = 'Stream: ' + (state.streaming ? 'LIVE' : 'Off');

    // Record
    const dotRec = document.getElementById('dot-record');
    const lblRec = document.getElementById('lbl-record');
    if (dotRec) dotRec.className = 'status-dot ' + (state.recording ? 'recording' : 'idle');
    if (lblRec) lblRec.textContent = 'Record: ' + (state.recording ? 'Recording' : 'Off');

    // Current scene
    const sceneLabel = document.getElementById('current-scene-name');
    if (sceneLabel) sceneLabel.textContent = state.currentScene || '--';

    // Scene grid
    if (state.scenes.length > 0) {
      const grid = document.getElementById('scene-grid');
      if (grid) {
        grid.innerHTML = state.scenes.map(s => `
          <button class="btn scene-btn ${s.name === state.currentScene ? 'active-scene' : ''}" data-scene-num="${s.index}">
            <span class="btn-label">${s.name}</span>
          </button>
        `).join('');

        grid.querySelectorAll('[data-scene-num]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const num = parseInt(btn.dataset.sceneNum);
            await ObsAPI.setScene(num);
            this.updateStatus();
          });
        });
      }
    }
  },

  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._stopCameraFeed();
  }
};
