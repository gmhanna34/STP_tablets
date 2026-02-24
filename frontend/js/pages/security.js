const SecurityPage = {
  _feedTimers: {},
  _activeTab: 'ptz',
  _haCameras: null, // cached from /api/ha/cameras

  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>SECURITY</h1>
        <div class="subtitle">Camera Overview</div>
      </div>

      <div class="cam-tab-bar">
        <button class="cam-tab active" data-tab="ptz">
          <span class="material-icons">videocam</span>
          <span>PTZ Cameras</span>
        </button>
        <button class="cam-tab" data-tab="security">
          <span class="material-icons">security</span>
          <span>Security Cameras</span>
        </button>
      </div>

      <div id="cam-ptz-content">
        <div class="camera-grid" id="ptz-grid"></div>
        <div class="text-center mt-16">
          <button class="btn" id="btn-security-grid" style="display:inline-flex;max-width:300px;">
            <span class="material-icons">grid_view</span>
            <span class="btn-label">View Security Grid on Displays</span>
          </button>
        </div>
      </div>

      <div id="cam-security-content" style="display:none;">
        <div class="camera-grid" id="security-grid">
          <div style="opacity:0.5;text-align:center;padding:20px;grid-column:1/-1;">Loading security cameras...</div>
        </div>
      </div>
    `;
  },

  init() {
    this._activeTab = 'ptz';

    // Tab switching
    document.querySelectorAll('.cam-tab').forEach(tab => {
      tab.addEventListener('click', () => this._switchTab(tab.dataset.tab));
    });

    // Render PTZ cameras
    this._renderPTZGrid();
    this._initPTZHandlers();

    // Security grid button
    document.getElementById('btn-security-grid')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('4', '11');
      await MoIPAPI.switchSource('4', '12');
      await MoIPAPI.switchSource('4', '13');
      App.showToast('Security grid sent to lobby displays');
    });

    // Start PTZ feeds (default tab)
    const cameraEntries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];
    cameraEntries.forEach(([key]) => this._startPTZFeed(key));
  },

  _switchTab(tab) {
    if (tab === this._activeTab) return;

    // Stop all running feeds
    this._stopAllFeeds();

    this._activeTab = tab;

    // Update tab buttons
    document.querySelectorAll('.cam-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    // Toggle content
    const ptzContent = document.getElementById('cam-ptz-content');
    const secContent = document.getElementById('cam-security-content');
    if (ptzContent) ptzContent.style.display = tab === 'ptz' ? '' : 'none';
    if (secContent) secContent.style.display = tab === 'security' ? '' : 'none';

    if (tab === 'ptz') {
      const entries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];
      entries.forEach(([key]) => this._startPTZFeed(key));
    } else {
      this._loadSecurityCameras();
    }
  },

  // ---------------------------------------------------------------------------
  // PTZ Camera Grid
  // ---------------------------------------------------------------------------

  _renderPTZGrid() {
    const grid = document.getElementById('ptz-grid');
    if (!grid) return;
    const entries = App.settings?.ptzCameras ? Object.entries(App.settings.ptzCameras) : [];

    grid.innerHTML = entries.map(([key, cam]) => `
      <div class="camera-card" data-cam-click="${key}" data-cam-type="ptz">
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
    `).join('');
  },

  _initPTZHandlers() {
    document.querySelectorAll('[data-ptz-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); // don't trigger card click
        const camKey = btn.dataset.cam;
        const action = btn.dataset.ptzAction;
        if (action === 'preset') {
          PtzAPI.callPreset(camKey, btn.dataset.val);
        } else if (action === 'home') {
          PtzAPI.home(camKey);
        }
      });
    });

    // Card click opens panel (on the feed area, not buttons)
    document.querySelectorAll('[data-cam-click][data-cam-type="ptz"]').forEach(card => {
      card.querySelector('.camera-feed')?.addEventListener('click', () => {
        this._openCameraPanel(card.dataset.camClick, 'ptz');
      });
    });
  },

  _startPTZFeed(camKey) {
    const refresh = () => {
      const img = document.getElementById(`img-${camKey}`);
      if (!img || !img.isConnected) return;

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

  // ---------------------------------------------------------------------------
  // Security (HA/UniFi Protect) Camera Grid
  // ---------------------------------------------------------------------------

  async _loadSecurityCameras() {
    const grid = document.getElementById('security-grid');
    if (!grid) return;

    if (!this._haCameras) {
      grid.innerHTML = '<div style="opacity:0.5;text-align:center;padding:20px;grid-column:1/-1;">Loading security cameras...</div>';
      try {
        const resp = await fetch('/api/ha/cameras', {
          headers: { 'X-Tablet-ID': localStorage.getItem('tabletId') || 'WebApp' },
        });
        const data = await resp.json();
        this._haCameras = data.cameras || [];
      } catch (e) {
        grid.innerHTML = '<div style="color:var(--danger);text-align:center;padding:20px;grid-column:1/-1;">Failed to load cameras from Home Assistant.</div>';
        return;
      }
    }

    if (this._haCameras.length === 0) {
      grid.innerHTML = '<div style="opacity:0.5;text-align:center;padding:20px;grid-column:1/-1;">No camera entities found in Home Assistant.</div>';
      return;
    }

    grid.innerHTML = this._haCameras.map(cam => {
      const safeId = cam.entity_id.replace(/\./g, '_');
      return `
        <div class="camera-card" data-cam-click="${cam.entity_id}" data-cam-type="ha">
          <div class="camera-header">${cam.friendly_name}</div>
          <div class="camera-feed" id="feed-${safeId}">
            <img id="img-${safeId}" alt="${cam.friendly_name}" style="width:100%;height:100%;object-fit:contain;display:none;">
            <span class="material-icons" id="placeholder-${safeId}" style="font-size:48px;opacity:0.3;">videocam</span>
          </div>
        </div>
      `;
    }).join('');

    // Click to open panel
    grid.querySelectorAll('[data-cam-click][data-cam-type="ha"]').forEach(card => {
      card.addEventListener('click', () => {
        this._openCameraPanel(card.dataset.camClick, 'ha');
      });
    });

    // Start snapshot polling for all HA cameras
    this._haCameras.forEach(cam => this._startHAFeed(cam.entity_id));
  },

  _startHAFeed(entityId) {
    const safeId = entityId.replace(/\./g, '_');
    const refresh = () => {
      const img = document.getElementById(`img-${safeId}`);
      if (!img || !img.isConnected) return;

      const next = new Image();
      next.onload = () => {
        img.src = next.src;
        img.style.display = 'block';
        const ph = document.getElementById(`placeholder-${safeId}`);
        if (ph) ph.style.display = 'none';
        this._feedTimers[safeId] = setTimeout(refresh, 3000);
      };
      next.onerror = () => {
        this._feedTimers[safeId] = setTimeout(refresh, 8000);
      };
      next.src = `/api/ha/camera/${entityId}/snapshot?t=${Date.now()}`;
    };
    refresh();
  },

  // ---------------------------------------------------------------------------
  // Camera Panel (enlarged single-camera view)
  // ---------------------------------------------------------------------------

  _openCameraPanel(camId, type) {
    const self = this;
    let title;

    if (type === 'ptz') {
      title = camId.replace(/_/g, ' ');
    } else {
      const cam = (this._haCameras || []).find(c => c.entity_id === camId);
      title = cam ? cam.friendly_name : camId;
    }

    App.showPanel(title, (body) => {
      body.style.padding = '0';
      body.style.display = 'flex';
      body.style.flexDirection = 'column';

      if (type === 'ptz') {
        body.innerHTML = `
          <div style="flex:1;background:#111;display:flex;align-items:center;justify-content:center;min-height:0;">
            <img id="panel-cam-img" alt="${title}" style="max-width:100%;max-height:100%;object-fit:contain;">
          </div>
          <div style="padding:12px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;border-top:1px solid var(--border);">
            <button class="btn" data-panel-ptz="preset" data-val="1" style="min-height:40px;padding:8px 16px;"><span class="btn-label">Preset 1</span></button>
            <button class="btn" data-panel-ptz="preset" data-val="2" style="min-height:40px;padding:8px 16px;"><span class="btn-label">Preset 2</span></button>
            <button class="btn" data-panel-ptz="preset" data-val="3" style="min-height:40px;padding:8px 16px;"><span class="btn-label">Preset 3</span></button>
            <button class="btn" data-panel-ptz="home" style="min-height:40px;padding:8px 16px;"><span class="material-icons" style="font-size:18px;">home</span></button>
          </div>
        `;

        // PTZ controls in panel
        body.querySelectorAll('[data-panel-ptz]').forEach(btn => {
          btn.addEventListener('click', () => {
            const action = btn.dataset.panelPtz;
            if (action === 'preset') PtzAPI.callPreset(camId, btn.dataset.val);
            else if (action === 'home') PtzAPI.home(camId);
          });
        });

        // Start snapshot feed in panel (faster refresh for single camera)
        const img = body.querySelector('#panel-cam-img');
        const refreshPanel = () => {
          if (!img || !img.isConnected) return;
          const next = new Image();
          next.onload = () => {
            img.src = next.src;
            self._feedTimers['_panel'] = setTimeout(refreshPanel, 1000);
          };
          next.onerror = () => {
            self._feedTimers['_panel'] = setTimeout(refreshPanel, 3000);
          };
          next.src = `/api/ptz/${camId}/snapshot?t=${Date.now()}`;
        };
        refreshPanel();
      } else {
        // HA camera — use MJPEG stream for smooth live view
        body.innerHTML = `
          <div style="flex:1;background:#111;display:flex;align-items:center;justify-content:center;min-height:0;">
            <img id="panel-cam-stream" alt="${title}"
              style="max-width:100%;max-height:100%;object-fit:contain;"
              src="/api/ha/camera/${camId}/stream">
          </div>
        `;
      }
    });
  },

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  _stopAllFeeds() {
    Object.values(this._feedTimers).forEach(t => clearTimeout(t));
    this._feedTimers = {};
  },

  destroy() {
    this._stopAllFeeds();
  }
};
