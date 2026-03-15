const StreamPage = {
  pollTimer: null,
  _resetTimer: null,
  _previewEnabled: false,
  _previewSwitchDelay: 1500,
  _liveStreamTx: 8,

  // OBS scene name → macro key for MoIP routing + X32 scene
  _sceneMacroMap: {
    'MainChurch_Rear': 'stream_scene_main_church',
    'MainChurch_Altar': 'stream_scene_main_church',
    'MainChurch_Right': 'stream_scene_main_church',
    'MainChurch_Left': 'stream_scene_main_church',
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
                  <span class="material-icons">record_voice_over</span>
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

        <!-- Slides and Preview: full width -->
        <div class="control-section">
          <div class="section-title">Slides and Preview</div>
          <div class="control-grid" style="grid-template-columns:repeat(3, 1fr);">
            <button class="btn" id="btn-slides-on"><span class="material-icons">slideshow</span><span class="btn-label">Slides On</span></button>
            <button class="btn" id="btn-slides-off"><span class="material-icons">block</span><span class="btn-label">Slides Off</span></button>
            <button class="btn" id="btn-stream-preview"><span class="material-icons">live_tv</span><span class="btn-label">Live Stream Feed Preview</span></button>
          </div>
        </div>

        <!-- Footer links -->
        <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
          <a class="section-link" href="#" id="link-stream-advanced">
            <span class="material-icons">chevron_right</span>
            <span>Advanced Settings</span>
          </a>
          <a class="section-link" href="#" id="link-obs-web">
            <span class="material-icons">chevron_right</span>
            <span>Web Control Popup</span>
          </a>
        </div>
      </div>

      <!-- Live Stream Feed Preview overlay -->
      <div id="stream-preview-overlay" class="moip-preview-overlay" style="display:none;">
        <div class="moip-preview-modal">
          <div class="moip-preview-header">
            <span class="material-icons">live_tv</span>
            <span>Live Stream Feed Preview</span>
            <button class="btn" id="btn-stream-preview-mute" title="Unmute audio" style="margin-left:auto;margin-right:8px;min-width:36px;padding:6px;">
              <span class="material-icons" style="font-size:20px;">volume_off</span>
            </button>
            <button class="moip-preview-close" id="btn-stream-preview-close">
              <span class="material-icons">close</span>
            </button>
          </div>
          <div class="moip-preview-body">
            <div id="stream-preview-loading" class="text-center" style="padding:40px;">
              <div class="spinner"></div>
              <div style="margin-top:12px;opacity:0.7;">Switching to live stream feed...</div>
            </div>
            <video id="stream-preview-stream" style="display:none;width:100%;border-radius:4px;background:#000;" muted autoplay playsinline></video>
            <div id="stream-preview-error" class="text-center" style="display:none;padding:30px;color:#cc0000;"></div>
          </div>
        </div>
      </div>
    `;
  },

  init() {
    // Initial HTTP poll for scene list, then rely on WebSocket for status
    this._pollObs();
    this._startCameraFeed();

    // Help button
    document.getElementById('stream-help-btn')?.addEventListener('click', () => this._showHelp());

    // Check if MoIP preview is enabled
    fetch('/api/moip/preview/config').then(r => r.json()).then(data => {
      this._previewEnabled = data.enabled;
      this._previewSwitchDelay = data.switch_delay_ms || 1500;
    }).catch(() => {});

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

    // Slides and Preview
    document.getElementById('btn-slides-on')?.addEventListener('click', () => ObsAPI.slidesOn());
    document.getElementById('btn-slides-off')?.addEventListener('click', () => ObsAPI.slidesOff());
    document.getElementById('btn-stream-preview')?.addEventListener('click', () => this._openStreamPreview());

    // Advanced Settings panel
    document.getElementById('link-stream-advanced')?.addEventListener('click', (e) => {
      e.preventDefault();
      this._openAdvancedSettings();
    });

    // Stream preview overlay close handlers
    document.getElementById('btn-stream-preview-close')?.addEventListener('click', () => this._closeStreamPreview());
    document.getElementById('stream-preview-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'stream-preview-overlay') this._closeStreamPreview();
    });

    // Stream preview mute/unmute toggle
    document.getElementById('btn-stream-preview-mute')?.addEventListener('click', () => {
      const vid = document.getElementById('stream-preview-stream');
      const btn = document.getElementById('btn-stream-preview-mute');
      if (!vid || !btn) return;
      vid.muted = !vid.muted;
      btn.querySelector('.material-icons').textContent = vid.muted ? 'volume_off' : 'volume_up';
      btn.title = vid.muted ? 'Unmute audio' : 'Mute audio';
    });

    // Track HLS.js instance for cleanup
    this._hlsInstance = null;

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
      this._feedTimeout = setTimeout(() => this._refreshCameraFeed(), 2000);
    };
    nextImg.onerror = () => {
      this._feedTimeout = setTimeout(() => this._refreshCameraFeed(), 2000);
    };
    const _tid = (typeof Auth !== 'undefined' && Auth.getTabletId) ? Auth.getTabletId() : '';
    nextImg.src = `/api/ptz/${camKey}/snapshot?t=${Date.now()}${_tid ? '&tablet=' + _tid : ''}`;
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
          self._panelFeedTimer = setTimeout(refreshPanel, 2000);
        };
        next.onerror = () => {
          self._panelFeedTimer = setTimeout(refreshPanel, 5000);
        };
        const _tid = (typeof Auth !== 'undefined' && Auth.getTabletId) ? Auth.getTabletId() : '';
        next.src = `/api/ptz/${camId}/snapshot?t=${Date.now()}${_tid ? '&tablet=' + _tid : ''}`;
      };
      refreshPanel();
    });
  },

  // HTTP poll with setTimeout chaining — prevents overlapping polls.
  // Runs every 10s as a fallback; real-time updates come via WebSocket.
  async _pollObs() {
    try {
      await ObsAPI.poll();
      this.updateStatus();
    } catch { /* ignore */ }
    this.pollTimer = setTimeout(() => this._pollObs(), 10000);
  },

  // UI-only refresh — reads from ObsAPI.state without making HTTP calls.
  // Called by WebSocket state push (via refreshCurrentPage) and after HTTP polls.
  updateStatus() {
    const state = ObsAPI.state;

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

  _openAdvancedSettings() {
    App.showPanel('Advanced Settings', (body) => {
      body.innerHTML = `
        <div class="control-grid" style="grid-template-columns:repeat(2, 1fr);gap:10px;">
          <button class="btn" id="adv-set-shure">
            <span class="material-icons">mic_external_on</span>
            <span class="btn-label">Shure Mic</span>
          </button>
          <button class="btn" id="adv-reenable-atem">
            <span class="material-icons">videocam</span>
            <span class="btn-label">ATEM</span>
          </button>
          <button class="btn" id="adv-slides-toggle">
            <span class="material-icons">swap_horiz</span>
            <span class="btn-label">Toggle Slides on Live Stream</span>
          </button>
          <button class="btn" id="adv-reset-stream">
            <span class="material-icons">restart_alt</span>
            <span class="btn-label">Reset Stream</span>
          </button>
        </div>
      `;

      body.querySelector('#adv-set-shure')?.addEventListener('click', () => ObsAPI.setAudioToShureMic());
      body.querySelector('#adv-reenable-atem')?.addEventListener('click', () => ObsAPI.reEnableBMATEMWebcam());
      body.querySelector('#adv-slides-toggle')?.addEventListener('click', () => ObsAPI.toggleSlides());
      body.querySelector('#adv-reset-stream')?.addEventListener('click', () => ObsAPI.resetLiveStream());
    });
  },

  async _openStreamPreview() {
    const overlay = document.getElementById('stream-preview-overlay');
    if (!overlay) return;

    overlay.style.display = 'flex';

    const loading = overlay.querySelector('#stream-preview-loading');
    const stream = overlay.querySelector('#stream-preview-stream');
    const error = overlay.querySelector('#stream-preview-error');
    const muteBtn = document.getElementById('btn-stream-preview-mute');

    if (loading) loading.style.display = '';
    if (stream) { stream.style.display = 'none'; stream.pause(); }
    if (error) error.style.display = 'none';

    // Destroy previous HLS instance and refresh timer
    if (this._hlsRefreshTimer) { clearTimeout(this._hlsRefreshTimer); this._hlsRefreshTimer = null; }
    if (this._hlsInstance) { this._hlsInstance.destroy(); this._hlsInstance = null; }

    // Reset mute button state (starts muted)
    if (stream) stream.muted = true;
    if (muteBtn) {
      muteBtn.querySelector('.material-icons').textContent = 'volume_off';
      muteBtn.title = 'Unmute audio';
    }

    try {
      const resp = await fetch('/api/moip/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transmitter: this._liveStreamTx }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      await new Promise(r => setTimeout(r, data.switch_delay_ms || this._previewSwitchDelay));

      if (loading) loading.style.display = 'none';
      if (!stream) return;

      const showError = (msg) => {
        stream.style.display = 'none';
        if (error) { error.textContent = msg; error.style.display = ''; }
      };

      // Append cache-buster to avoid stale segments after TX switch
      const cbUrl = data.stream_url + (data.stream_url.includes('?') ? '&' : '?') + '_cb=' + Date.now();
      if (data.stream_type === 'hls') {
        this._startHls(stream, cbUrl, showError);
      } else {
        // Legacy MJPEG fallback
        stream.src = cbUrl;
        stream.style.display = '';
        stream.onerror = () => showError('Stream unavailable. Check encoder connection.');
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (error) {
        error.textContent = e.message || 'Failed to start preview';
        error.style.display = '';
      }
    }
  },

  _startHls(stream, url, showError) {
    // HLS stream — use HLS.js on Chrome/Android, native on Safari/iOS
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 1,        // Stay just 1 segment behind live edge
        liveMaxLatencyDurationCount: 3,  // Max drift before seeking forward
        maxBufferLength: 4,              // Don't over-buffer
        backBufferLength: 0,             // Discard played segments immediately
      });
      this._hlsInstance = hls;
      hls.loadSource(url);
      hls.attachMedia(stream);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        stream.style.display = '';
        stream.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, errData) => {
        if (errData.fatal) showError('Stream unavailable. Check encoder connection.');
      });
      // Safety net: after 4s, reload manifest to ensure we have fresh segments
      // (covers edge case where first load grabbed stale encoder segments)
      this._hlsRefreshTimer = setTimeout(() => {
        if (this._hlsInstance === hls) {
          hls.stopLoad();
          hls.startLoad(-1);  // -1 = start from live edge
        }
      }, 4000);
    } else if (stream.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS — clear old source first to prevent stale cache
      stream.removeAttribute('src');
      stream.load();
      stream.src = url;
      stream.style.display = '';
      stream.play().catch(() => {});
      stream.onerror = () => showError('Stream unavailable. Check encoder connection.');
      // Safety net: reload from live edge after 4s to flush any stale segments
      this._hlsRefreshTimer = setTimeout(() => {
        if (stream.src && stream.src.includes('_cb=')) {
          const currentSrc = stream.src;
          stream.removeAttribute('src');
          stream.load();
          stream.src = currentSrc;
          stream.play().catch(() => {});
        }
      }, 4000);
    } else {
      showError('HLS playback not supported on this browser.');
    }
  },

  _closeStreamPreview() {
    const overlay = document.getElementById('stream-preview-overlay');
    const stream = overlay?.querySelector('#stream-preview-stream');
    if (overlay) overlay.style.display = 'none';
    // Clear refresh timer
    if (this._hlsRefreshTimer) { clearTimeout(this._hlsRefreshTimer); this._hlsRefreshTimer = null; }
    // Destroy HLS instance and stop video
    if (this._hlsInstance) { this._hlsInstance.destroy(); this._hlsInstance = null; }
    if (stream) { stream.pause(); stream.removeAttribute('src'); stream.load(); stream.style.display = 'none'; }
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
              <dt><span class="material-icons">record_voice_over</span> Podium View</dt>
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
            <h3>Slides and Preview</h3>
            <dl class="help-list">
              <dt><span class="material-icons">slideshow</span> Slides On / Off</dt>
              <dd>Controls the slides overlay on the live stream output.</dd>
              <dt><span class="material-icons">live_tv</span> Live Stream Feed Preview</dt>
              <dd>Opens a live MJPEG preview of the stream feed from the HDMI encoder, showing exactly what the live stream output looks like.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Advanced Settings</h3>
            <dl class="help-list">
              <dt><span class="material-icons">mic_external_on</span> Shure Mic</dt>
              <dd>Sets the OBS audio input to the Shure wireless microphone.</dd>
              <dt><span class="material-icons">videocam</span> ATEM</dt>
              <dd>Re-enables the Blackmagic ATEM webcam input in OBS.</dd>
              <dt><span class="material-icons">swap_horiz</span> Toggle Slides on Live Stream</dt>
              <dd>Toggles the slides overlay on the live stream output.</dd>
              <dt><span class="material-icons">restart_alt</span> Reset Stream</dt>
              <dd>Resets the OBS live stream configuration via Advanced Scene Switcher. Use if YouTube shows a stream error.</dd>
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
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this._stopCameraFeed();
    this._closeStreamPreview();
    // Don't clear _resetTimer on page navigation — the 3-min reset should still fire
  }
};
