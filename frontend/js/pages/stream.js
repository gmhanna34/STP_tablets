const StreamPage = {
  pollTimer: null,
  _resetTimer: null,

  // OBS scene name → macro key for MoIP routing + X32 scene
  _sceneMacroMap: {
    'MainChurch_Rear': 'stream_scene_main_church',
    'MainChurch_Altar': 'stream_scene_main_church',
    'MainChurch_Right': 'stream_scene_main_church',
    'MainChurch_Side_Right': 'stream_scene_main_church',
    'MainChurch_Left': 'stream_scene_main_church',
    'MainChurch_Side_Left': 'stream_scene_main_church',
    'Chapel_Rear': 'stream_scene_chapel',
    'Chapel_Side': 'stream_scene_chapel',
    'BaptismRoom': 'stream_scene_other',
    'SocialHall_Rear': 'stream_scene_social_hall',
    'SocialHall_Side': 'stream_scene_social_hall',
    'Gym': 'stream_scene_other',
  },

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>LIVE STREAM</h1>
          <button class="help-icon-btn" id="stream-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
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

        <!-- Scenes: left half -->
        <div class="control-section col-span-6">
          <div class="section-title">Scenes</div>
          <div class="scene-grid" id="scene-grid">
            <div class="text-center" style="grid-column:1/-1;opacity:0.5;">Loading scenes...</div>
          </div>
        </div>

        <!-- Active Camera Snapshot: right half, spans 2 rows -->
        <div class="control-section col-span-6" style="grid-row: span 2;">
          <div class="section-title">Active Camera</div>
          <div class="camera-card">
            <div class="camera-header" id="camera-label">No active camera</div>
            <div class="camera-feed-wrapper">
              <div class="camera-feed" id="camera-feed" style="cursor:pointer;">
                <span class="material-icons">videocam</span>
                <div style="font-size:11px;margin-top:4px;">Waiting for scene...</div>
              </div>
              <div class="camera-preset-bar" id="camera-preset-bar" style="display:none;">
                <button class="btn camera-preset-btn" id="btn-preset-full" title="Preset 1: Full View">
                  <span class="material-icons">panorama_wide_angle</span>
                  <span class="btn-label">Full View</span>
                </button>
                <button class="btn camera-preset-btn" id="btn-preset-podium" title="Preset 2: Podium View">
                  <span class="material-icons">podium</span>
                  <span class="btn-label">Podium View</span>
                </button>
              </div>
            </div>
          </div>
          <div class="text-center" style="font-size:11px;opacity:0.5;margin-top:4px;">Tap image to open camera controls</div>
        </div>

        <!-- Stream & Record: left half, below Scenes -->
        <div class="control-section col-span-6">
          <div class="section-title">Stream & Record</div>
          <div class="control-grid" style="grid-template-columns:repeat(2, 1fr);">
            <button class="btn" id="btn-start-stream"><span class="material-icons">play_arrow</span><span class="btn-label">Start Stream</span></button>
            <button class="btn btn-danger" id="btn-stop-stream"><span class="material-icons">stop</span><span class="btn-label">Stop Stream</span></button>
            <button class="btn" id="btn-start-record"><span class="material-icons">fiber_manual_record</span><span class="btn-label">Start Record</span></button>
            <button class="btn btn-danger" id="btn-stop-record"><span class="material-icons">stop</span><span class="btn-label">Stop Record</span></button>
          </div>
        </div>		

        <!-- Slides & Advanced: full width -->
        <div class="control-section">
          <div class="section-title">Slides & Advanced</div>
          <div class="control-grid" style="grid-template-columns:repeat(6, 1fr);">
            <button class="btn" id="btn-slides-on"><span class="material-icons">slideshow</span><span class="btn-label">Slides On</span></button>
            <button class="btn" id="btn-slides-off"><span class="material-icons">block</span><span class="btn-label">Slides Off</span></button>
            <button class="btn" id="btn-slides-toggle"><span class="material-icons">swap_horiz</span><span class="btn-label">Toggle</span></button>
            <button class="btn" id="btn-reset-stream"><span class="material-icons">restart_alt</span><span class="btn-label">Reset Stream</span></button>
            <button class="btn" id="btn-set-shure"><span class="material-icons">mic_external_on</span><span class="btn-label">Shure Mic</span></button>
            <button class="btn" id="btn-reenable-atem"><span class="material-icons">videocam</span><span class="btn-label">ATEM</span></button>
          </div>
        </div>

        <!-- Footer link -->
        <a class="section-link" href="#" id="link-obs-web" style="justify-self:center;">
          <span class="material-icons">chevron_right</span>
          <span>Web Control Popup</span>
        </a>
      </div>
    `;
  },

  init() {
    // Start polling OBS
    this.updateStatus();
    this.pollTimer = setInterval(() => this.updateStatus(), 3000);

    // Help button
    document.getElementById('stream-help-btn')?.addEventListener('click', () => this._showHelp());

    // Stream/Record buttons
    document.getElementById('btn-start-stream')?.addEventListener('click', async () => {
      // Safety reset before starting — clears any stale YouTube state
      try { await ObsAPI.resetLiveStream(); } catch {}
      await ObsAPI.startStream();
      this.updateStatus();
    });
    document.getElementById('btn-stop-stream')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Stop the live stream? This will end the broadcast for all viewers.')) return;
      await ObsAPI.stopStream();
      this.updateStatus();
      // Schedule a stream reset after 3 minutes to acknowledge YouTube end-of-stream
      this._scheduleStreamReset();
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

    // Click camera snapshot to open PTZ popup
    document.getElementById('camera-feed')?.addEventListener('click', () => {
      const camKey = this.getCurrentCameraKey();
      if (camKey) this._openPtzPanel(camKey);
    });

    // Preset buttons on camera snapshot
    document.getElementById('btn-preset-full')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const camKey = this.getCurrentCameraKey();
      if (camKey) PtzAPI.callPreset(camKey, '1');
    });
    document.getElementById('btn-preset-podium')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const camKey = this.getCurrentCameraKey();
      if (camKey) PtzAPI.callPreset(camKey, '2');
    });

    // Footer links
    document.getElementById('link-obs-web')?.addEventListener('click', (e) => {
      e.preventDefault();
      App.showPanel('Web Control Popup', (body) => {
        body.style.padding = '0';
        body.innerHTML = `
          <iframe src="http://obs-web.niek.tv/#ws://external.stpauloc.org:4455"
            style="width:100%;height:100%;border:none;border-radius:0 0 16px 16px;"
            allow="fullscreen">
          </iframe>
        `;
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

    const presetBar = document.getElementById('camera-preset-bar');

    // No camera mapped to current scene
    if (!camKey) {
      if (this._activeCamKey) {
        feedEl.innerHTML = `<span class="material-icons">videocam</span>
          <div style="font-size:12px;margin-top:4px;">Waiting for scene...</div>`;
        this._activeCamKey = null;
      }
      if (labelEl) labelEl.textContent = 'No active camera';
      if (presetBar) presetBar.style.display = 'none';
      this._feedTimeout = setTimeout(() => this._refreshCameraFeed(), 2000);
      return;
    }

    if (presetBar) presetBar.style.display = '';

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

  _panelFeedTimer: null,

  _openPtzPanel(camId) {
    const self = this;
    const title = camId.replace(/_/g, ' ');

    App.showPanel(title, (body) => {
      body.style.padding = '0';
      body.style.display = 'flex';
      body.style.flexDirection = 'column';

      body.innerHTML = `
        <div style="flex:1;background:#111;display:flex;align-items:center;justify-content:center;min-height:0;position:relative;">
          <img id="panel-cam-img" alt="${title}" style="max-width:100%;max-height:100%;object-fit:contain;">
          <div class="ptz-overlay">
            <div class="ptz-overlay-row">
              <div class="ptz-grid">
                <div></div>
                <button class="btn ptz-btn" data-panel-ptz="move" data-dir="up"><span class="material-icons">arrow_upward</span></button>
                <div></div>
                <button class="btn ptz-btn" data-panel-ptz="move" data-dir="left"><span class="material-icons">arrow_back</span></button>
                <button class="btn ptz-btn" data-panel-ptz="home"><span class="material-icons">home</span></button>
                <button class="btn ptz-btn" data-panel-ptz="move" data-dir="right"><span class="material-icons">arrow_forward</span></button>
                <div></div>
                <button class="btn ptz-btn" data-panel-ptz="move" data-dir="down"><span class="material-icons">arrow_downward</span></button>
                <div></div>
              </div>
              <div class="ptz-zoom">
                <button class="btn ptz-btn" data-panel-ptz="zoom" data-dir="in"><span class="material-icons">zoom_in</span></button>
                <button class="btn ptz-btn" data-panel-ptz="zoom" data-dir="out"><span class="material-icons">zoom_out</span></button>
              </div>
            </div>
            <div class="ptz-presets">
              <button class="btn ptz-btn" data-panel-ptz="preset" data-val="1"><span class="btn-label">P1</span></button>
              <button class="btn ptz-btn" data-panel-ptz="preset" data-val="2"><span class="btn-label">P2</span></button>
              <button class="btn ptz-btn" data-panel-ptz="preset" data-val="3"><span class="btn-label">P3</span></button>
            </div>
          </div>
        </div>
      `;

      // Pan/tilt: hold to move, release to stop
      body.querySelectorAll('[data-panel-ptz="move"]').forEach(btn => {
        const dir = btn.dataset.dir;
        const start = () => PtzAPI.panTilt(camId, dir);
        const stop = () => PtzAPI.panTilt(camId, 'ptzstop');
        btn.addEventListener('mousedown', start);
        btn.addEventListener('mouseup', stop);
        btn.addEventListener('mouseleave', stop);
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); stop(); });
        btn.addEventListener('touchcancel', stop);
      });

      // Zoom: hold to zoom, release to stop
      body.querySelectorAll('[data-panel-ptz="zoom"]').forEach(btn => {
        const dir = btn.dataset.dir;
        const start = () => dir === 'in' ? PtzAPI.zoomIn(camId) : PtzAPI.zoomOut(camId);
        const stop = () => PtzAPI.zoomStop(camId);
        btn.addEventListener('mousedown', start);
        btn.addEventListener('mouseup', stop);
        btn.addEventListener('mouseleave', stop);
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); start(); }, { passive: false });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); stop(); });
        btn.addEventListener('touchcancel', stop);
      });

      // Presets and home: simple click
      body.querySelectorAll('[data-panel-ptz="preset"]').forEach(btn => {
        btn.addEventListener('click', () => PtzAPI.callPreset(camId, btn.dataset.val));
      });
      body.querySelector('[data-panel-ptz="home"]')?.addEventListener('click', () => PtzAPI.home(camId));

      // Snapshot refresh loop
      const img = body.querySelector('#panel-cam-img');
      const refreshPanel = () => {
        if (!img || !img.isConnected) return;
        const next = new Image();
        next.onload = () => {
          img.src = next.src;
          self._panelFeedTimer = setTimeout(refreshPanel, 1000);
        };
        next.onerror = () => {
          self._panelFeedTimer = setTimeout(refreshPanel, 3000);
        };
        next.src = `/api/ptz/${camId}/snapshot?t=${Date.now()}`;
      };
      refreshPanel();
    });
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

    // Stream/Record button states
    const btnStartStream = document.getElementById('btn-start-stream');
    const btnStopStream = document.getElementById('btn-stop-stream');
    const btnStartRecord = document.getElementById('btn-start-record');
    const btnStopRecord = document.getElementById('btn-stop-record');

    if (btnStartStream) {
      btnStartStream.disabled = state.streaming;
      btnStartStream.classList.toggle('active-danger', state.streaming);
      const streamLabel = btnStartStream.querySelector('.btn-label');
      if (streamLabel) streamLabel.textContent = state.streaming ? 'Stream is Live' : 'Start Stream';
    }
    if (btnStopStream) {
      btnStopStream.disabled = !state.streaming;
    }
    if (btnStartRecord) {
      btnStartRecord.disabled = state.recording;
      btnStartRecord.classList.toggle('active-danger', state.recording);
      const recordLabel = btnStartRecord.querySelector('.btn-label');
      if (recordLabel) recordLabel.textContent = state.recording ? 'Recording is Live' : 'Start Record';
    }
    if (btnStopRecord) {
      btnStopRecord.disabled = !state.recording;
    }

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
            // Fire MoIP audio routing + X32 scene macro based on scene name
            const scene = ObsAPI.state.scenes.find(s => s.index === num);
            if (scene) {
              const macroKey = this._sceneMacroMap[scene.name];
              if (macroKey) MacroAPI.execute(macroKey);
            }
            this.updateStatus();
          });
        });
      }
    }
  },

  _scheduleStreamReset() {
    // Clear any previous reset timer
    if (this._resetTimer) clearTimeout(this._resetTimer);
    App.showToast('Stream reset scheduled in 3 minutes...', 4000);
    this._resetTimer = setTimeout(async () => {
      this._resetTimer = null;
      try {
        await ObsAPI.resetLiveStream();
        App.showToast('YouTube stream reset complete', 3000);
      } catch {
        App.showToast('Stream reset failed — try Reset Stream manually', 4000);
      }
    }, 180000); // 3 minutes
  },

  _showHelp() {
    App.showPanel('Live Stream - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page controls the YouTube live stream and recording via OBS, manages camera views, and provides scene switching.</p>
          </div>

          <div class="help-section">
            <h3>Status Bar</h3>
            <p class="help-note">Shows real-time connection, stream, and recording status with color-coded indicators. Also displays the current active OBS scene.</p>
          </div>

          <div class="help-section">
            <h3>Scenes</h3>
            <p class="help-note">Click any scene button to switch the OBS output to that camera/view. The active scene is highlighted.</p>
          </div>

          <div class="help-section">
            <h3>Active Camera</h3>
            <dl class="help-list">
              <dt>Camera Snapshot</dt>
              <dd>Shows a live preview from the current scene's camera. Tap the image to open full PTZ (pan/tilt/zoom) controls.</dd>
              <dt><span class="material-icons">panorama_wide_angle</span> Full View</dt>
              <dd>Moves the active camera to Preset 1 (wide/full view of the space).</dd>
              <dt><span class="material-icons">podium</span> Podium View</dt>
              <dd>Moves the active camera to Preset 2 (zoomed in on the podium/altar).</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Stream & Record</h3>
            <dl class="help-list">
              <dt><span class="material-icons">play_arrow</span> Start Stream / Stream is Live</dt>
              <dd>Starts the YouTube live stream. When active, the button turns red and pulsates. The stream goes live to all viewers.</dd>
              <dt><span class="material-icons">stop</span> Stop Stream</dt>
              <dd>Stops the YouTube live stream. Shows a confirmation dialog first. After stopping, a 3-minute delayed reset prepares YouTube for the next stream.</dd>
              <dt><span class="material-icons">fiber_manual_record</span> Start Record / Recording is Live</dt>
              <dd>Starts local recording. When active, the button turns red and pulsates.</dd>
              <dt><span class="material-icons">stop</span> Stop Record</dt>
              <dd>Stops local recording.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Slides & Advanced</h3>
            <dl class="help-list">
              <dt><span class="material-icons">slideshow</span> Slides On / Off / Toggle</dt>
              <dd>Controls the slides overlay on the live stream output.</dd>
              <dt><span class="material-icons">restart_alt</span> Reset Stream</dt>
              <dd>Resets the OBS live stream configuration via Advanced Scene Switcher. Use if YouTube shows a stream error.</dd>
              <dt><span class="material-icons">mic_external_on</span> Shure Mic</dt>
              <dd>Sets the OBS audio input to the Shure wireless microphone.</dd>
              <dt><span class="material-icons">videocam</span> ATEM</dt>
              <dd>Re-enables the Blackmagic ATEM webcam input in OBS.</dd>
            </dl>
          </div>

          <div class="help-section" style="border-bottom:none;text-align:center;padding-top:16px;">
            <button class="btn" id="help-ask-chat" style="display:inline-flex;max-width:320px;">
              <span class="material-icons">support_agent</span>
              <span class="btn-label">Ask a Question</span>
            </button>
          </div>
        </div>
      `;
      body.querySelector('#help-ask-chat')?.addEventListener('click', () => {
        App.closePanel();
        App.openChat('stream');
      });
    });
  },

  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this._stopCameraFeed();
    // Don't clear _resetTimer on page navigation — the 3-min reset should still fire
  }
};
