const SourcePage = {
  pollTimer: null,
  mixerTimer: null,
  transmitters: [],
  receivers: [],
  _activeTab: 'video',
  _announcementsLoaded: false,
  _announceConfig: null,
  _announceProgressBound: false,
  _announceLog: [],
  _testLoaded: false,
  _testLog: [],
  _wiimLoaded: false,
  _wiimEntity: 'media_player.wiim_pro_new',
  _previewEnabled: false,
  _previewSwitchDelay: 1500,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>SOURCE ROUTING</h1>
          <div class="subtitle">MoIP Video &amp; Audio Distribution</div>
          <button class="help-icon-btn" id="source-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
        </div>

        <div class="cam-tab-bar">
          <button class="cam-tab active" data-source-tab="video">
            <span class="material-icons">settings_input_hdmi</span>
            <span>Video</span>
          </button>
          <button class="cam-tab" data-source-tab="audio">
            <span class="material-icons">equalizer</span>
            <span>Audio</span>
          </button>
          <button class="cam-tab" data-source-tab="announcements">
            <span class="material-icons">campaign</span>
            <span>Announcements</span>
          </button>
          <button class="cam-tab" data-source-tab="test">
            <span class="material-icons">science</span>
            <span>Test</span>
          </button>
        </div>

        <!-- VIDEO TAB -->
        <div id="source-tab-video">
          <div class="text-center" style="margin-bottom:8px;display:flex;justify-content:center;gap:8px;">
            <button class="btn" id="btn-refresh-routing" style="display:inline-flex;max-width:200px;">
              <span class="material-icons">refresh</span>
              <span class="btn-label">Refresh</span>
            </button>
            <button class="btn" id="btn-preview-tx" style="display:none;max-width:240px;">
              <span class="material-icons">visibility</span>
              <span class="btn-label">Preview Source</span>
            </button>
          </div>
          <div id="routing-container">
            <div class="text-center" style="opacity:0.5;">Loading receiver mappings...</div>
          </div>
        </div>

        <!-- PREVIEW MODAL (hidden by default) -->
        <div id="moip-preview-overlay" class="moip-preview-overlay" style="display:none;">
          <div class="moip-preview-modal">
            <div class="moip-preview-header">
              <span class="material-icons" style="vertical-align:middle;">visibility</span>
              <span id="moip-preview-title">Preview</span>
              <button class="moip-preview-close" id="btn-preview-close">
                <span class="material-icons">close</span>
              </button>
            </div>
            <div class="moip-preview-body">
              <div id="moip-preview-loading" class="text-center" style="padding:40px;">
                <span class="material-icons spinning" style="font-size:40px;opacity:0.5;">sync</span>
                <div style="margin-top:8px;opacity:0.5;">Switching source...</div>
              </div>
              <img id="moip-preview-stream" style="display:none;width:100%;border-radius:4px;" />
              <div id="moip-preview-error" class="text-center" style="display:none;padding:30px;color:#cc0000;"></div>
            </div>
            <div class="moip-preview-footer">
              <select id="moip-preview-tx-select" class="routing-select" style="flex:1;"></select>
              <button class="btn" id="btn-preview-switch" style="max-width:120px;">
                <span class="material-icons">swap_horiz</span>
                <span class="btn-label">Switch</span>
              </button>
            </div>
          </div>
        </div>

        <!-- AUDIO TAB -->
        <div id="source-tab-audio" style="display:none;">
          <div class="control-section">
            <div class="section-title">Quick Actions</div>
            <div class="control-grid" style="grid-template-columns:repeat(4, 1fr);" id="x32-quick-actions">
              <button class="btn" id="x32-mute-all"><span class="material-icons">volume_off</span><span class="btn-label">Mute All</span></button>
              <button class="btn" id="x32-unmute-all"><span class="material-icons">volume_up</span><span class="btn-label">Unmute All</span></button>
              <button class="btn" id="x32-reload-scene"><span class="material-icons">refresh</span><span class="btn-label">Reload Scene</span></button>
              <button class="btn" id="x32-mute-band"><span class="material-icons">music_off</span><span class="btn-label">Mute Music</span></button>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">Mixer Scenes</div>
            <div class="scene-grid" id="x32-scenes"></div>
          </div>
          <div class="control-section">
            <div class="section-title">Input Channels</div>
            <div id="mixer-container">
              <div class="text-center" style="opacity:0.5;">Loading mixer status...</div>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">Aux Inputs</div>
            <div id="aux-container" class="mixer-grid"></div>
          </div>
          <div class="control-section">
            <div class="section-title">Mix Buses</div>
            <div id="bus-container" class="mixer-grid"></div>
          </div>
          <div class="control-section">
            <div class="section-title">DCA Groups</div>
            <div id="dca-container" class="mixer-grid"></div>
          </div>
        </div>

        <!-- ANNOUNCEMENTS TAB -->
        <div id="source-tab-announcements" style="display:none;">
          <!-- Voice selector (global) -->
          <div class="announce-voice-bar">
            <span class="material-icons" style="font-size:18px;color:var(--text-secondary);">record_voice_over</span>
            <label style="font-size:12px;color:var(--text-secondary);white-space:nowrap;">Voice:</label>
            <select id="announce-voice-select" class="routing-select" style="flex:1;max-width:250px;"></select>
          </div>

          <!-- Sub-tabs -->
          <div class="announce-sub-tabs">
            <button class="announce-sub-tab active" data-announce-tab="presets">
              <span class="material-icons">touch_app</span> Presets
            </button>
            <button class="announce-sub-tab" data-announce-tab="sequences">
              <span class="material-icons">playlist_play</span> Sequences
            </button>
            <button class="announce-sub-tab" data-announce-tab="custom">
              <span class="material-icons">edit_note</span> Custom
            </button>
          </div>

          <!-- PRESETS SUB-TAB -->
          <div id="announce-tab-presets">
            <div id="announce-presets-grid" class="announce-presets-grid">
              <div class="text-center" style="opacity:0.5;">Loading presets...</div>
            </div>
          </div>

          <!-- SEQUENCES SUB-TAB -->
          <div id="announce-tab-sequences" style="display:none;">
            <div id="announce-sequences-list">
              <div class="text-center" style="opacity:0.5;">Loading sequences...</div>
            </div>
          </div>

          <!-- CUSTOM SUB-TAB -->
          <div id="announce-tab-custom" style="display:none;">
            <div class="control-section">
              <div class="section-title">Custom Text Announcement</div>
              <textarea id="announce-custom-text" class="announce-textarea"
                placeholder="Type your announcement message..." rows="3"></textarea>
              <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="btn" id="btn-announce-custom" style="max-width:180px;">
                  <span class="material-icons">campaign</span>
                  <span class="btn-label">Announce</span>
                </button>
              </div>
            </div>
            <div class="control-section">
              <div class="section-title">Play Audio File</div>
              <div style="display:flex;gap:8px;align-items:center;">
                <label class="btn" style="max-width:180px;cursor:pointer;">
                  <span class="material-icons">upload_file</span>
                  <span class="btn-label">Choose File</span>
                  <input type="file" id="announce-file-input" accept="audio/*" style="display:none;" />
                </label>
                <span id="announce-file-name" style="font-size:12px;color:var(--text-secondary);">No file selected</span>
              </div>
              <button class="btn" id="btn-announce-play-file" style="max-width:180px;margin-top:8px;" disabled>
                <span class="material-icons">play_circle</span>
                <span class="btn-label">Upload &amp; Play</span>
              </button>
            </div>
          </div>

          <!-- ACTIVITY LOG -->
          <div class="control-section">
            <div class="section-title" style="display:flex;align-items:center;justify-content:space-between;">
              <span>Activity Log</span>
              <button class="btn" id="btn-announce-clear-log" style="min-width:auto;padding:4px 10px;font-size:11px;">
                <span class="material-icons" style="font-size:14px;">delete_sweep</span>
                <span class="btn-label">Clear</span>
              </button>
            </div>
            <div id="announce-log-container" style="max-height:250px;overflow-y:auto;font-size:12px;font-family:monospace;">
              <div class="text-center" style="opacity:0.4;">No announcements yet</div>
            </div>
          </div>
        </div>

        <!-- TEST TAB -->
        <div id="source-tab-test" style="display:none;">
          <div class="control-section">
            <div class="section-title">Announcement Method Testing</div>
            <p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px;">
              Test different announcement delivery methods to compare reliability and latency. Results are logged below each test.
            </p>
            <div id="test-container">
              <div class="text-center" style="opacity:0.5;">Loading test panel...</div>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">WiiM Pro — Media Player Testing</div>
            <p style="font-size:12px;color:var(--text-secondary);margin:0 0 12px;">
              Test WiiM Pro media player via Home Assistant (media_player.wiim_pro_new). Use TTS to play announcements directly through the WiiM.
            </p>
            <div id="wiim-container">
              <div class="text-center" style="opacity:0.5;">Loading WiiM panel...</div>
            </div>
          </div>
          <div class="control-section">
            <div class="section-title">Test Log</div>
            <div id="test-log-container" style="max-height:300px;overflow-y:auto;font-size:12px;font-family:monospace;">
              <div class="text-center" style="opacity:0.4;">No tests run yet</div>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  init() {
    document.getElementById('source-help-btn')?.addEventListener('click', () => this._showHelp());

    // Load device config
    if (App.devicesConfig?.moip) {
      this.transmitters = App.devicesConfig.moip.transmitters || [];
      this.receivers = App.devicesConfig.moip.receivers || [];
    }

    // Tab switching
    document.querySelectorAll('[data-source-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.sourceTab;
        if (target === this._activeTab) return;
        this._activeTab = target;
        document.querySelectorAll('[data-source-tab]').forEach(t => t.classList.toggle('active', t.dataset.sourceTab === target));
        document.getElementById('source-tab-video').style.display = target === 'video' ? '' : 'none';
        document.getElementById('source-tab-audio').style.display = target === 'audio' ? '' : 'none';
        document.getElementById('source-tab-announcements').style.display = target === 'announcements' ? '' : 'none';
        document.getElementById('source-tab-test').style.display = target === 'test' ? '' : 'none';

        if (target === 'audio' && !this.mixerTimer) {
          this._initAudio();
        }
        if (target === 'announcements' && !this._announcementsLoaded) {
          this._initAnnouncements();
        }
        if (target === 'test' && !this._testLoaded) {
          this._initTestPanel();
        }
        if (target === 'test' && !this._wiimLoaded) {
          this._initWiimPanel();
        }
      });
    });

    // Check if preview is enabled
    fetch('/api/moip/preview/config').then(r => r.json()).then(data => {
      this._previewEnabled = data.enabled;
      this._previewSwitchDelay = data.switch_delay_ms || 1500;
      this._initPreview();
    }).catch(() => {});

    this.loadRouting();

    document.getElementById('btn-refresh-routing')?.addEventListener('click', () => this.loadRouting());
  },

  _initAudio() {
    this.loadMixer();
    this._wireX32QuickActions();
  },

  // UI-only refresh — reads from cached API state without HTTP calls.
  // Called by Socket.IO state push (via App.refreshCurrentPage).
  updateStatus() {
    this._renderRouting(MoIPAPI.state);
    if (this._activeTab === 'audio') {
      this._renderMixer(X32API.state);
    }
  },

  async loadMixer() {
    const state = await X32API.poll();
    this._renderMixer(state);
  },

  _renderMixer(state) {
    const container = document.getElementById('mixer-container');
    if (!container) return;

    if (!state.online) {
      container.innerHTML = '<div class="text-center" style="color:#cc0000;">X32 Mixer Offline</div>';
      return;
    }

    // Render channels
    const activeChannels = state.channels.filter(ch => ch.name && ch.name.trim() !== '');
    container.innerHTML = `
      <div class="mixer-grid">
        ${activeChannels.map(ch => `
          <div class="mixer-channel">
            <div class="channel-name" title="${ch.name}">${ch.name}</div>
            <input type="range" class="channel-fader" min="0" max="100" value="${Math.round(ch.volume * 100)}"
              data-ch="${ch.id}" orient="vertical" />
            <div class="channel-volume">${Math.round(ch.volume * 100)}%</div>
            <button class="channel-mute ${ch.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-ch="${ch.id}">
              ${ch.muted === 'muted' ? 'MUTED' : 'ON'}
            </button>
          </div>
        `).join('')}
      </div>
    `;

    // Mute handlers
    container.querySelectorAll('[data-mute-ch]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const chId = parseInt(btn.dataset.muteCh);
        const ch = state.channels.find(c => c.id === chId);
        if (ch && ch.muted === 'muted') {
          await X32API.unmuteChannel(chId);
        } else {
          await X32API.muteChannel(chId);
        }
        setTimeout(() => this.loadMixer(), 500);
      });
    });

    // Scenes
    const scenesContainer = document.getElementById('x32-scenes');
    if (scenesContainer) {
      const activeScenes = state.scenes.filter(s => s.name && s.name.trim() !== '');
      scenesContainer.innerHTML = activeScenes.map(s => `
        <button class="btn scene-btn ${String(state.currentScene) === String(s.id) ? 'active-scene' : ''}" data-x32-scene="${s.id}">
          <span class="btn-label">${s.name}</span>
        </button>
      `).join('');

      scenesContainer.querySelectorAll('[data-x32-scene]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await X32API.loadScene(parseInt(btn.dataset.x32Scene));
          App.showToast('Loading scene...');
          setTimeout(() => this.loadMixer(), 1000);
        });
      });
    }

    // Aux channels
    const auxContainer = document.getElementById('aux-container');
    if (auxContainer) {
      const activeAux = state.auxChannels.filter(a => a.name && a.name.trim() !== '');
      auxContainer.innerHTML = activeAux.map(a => `
        <div class="mixer-channel">
          <div class="channel-name" title="${a.name}">${a.name}</div>
          <div class="channel-volume">${Math.round(a.volume * 100)}%</div>
          <button class="channel-mute ${a.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-aux="${a.id}">
            ${a.muted === 'muted' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      auxContainer.querySelectorAll('[data-mute-aux]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const auxId = parseInt(btn.dataset.muteAux);
          const aux = state.auxChannels.find(a => a.id === auxId);
          if (aux && aux.muted === 'muted') {
            await X32API.unmuteAux(auxId);
          } else {
            await X32API.muteAux(auxId);
          }
          setTimeout(() => this.loadMixer(), 500);
        });
      });
    }

    // Mix Buses
    const busContainer = document.getElementById('bus-container');
    if (busContainer) {
      const activeBuses = state.buses.filter(b => b.name && b.name.trim() !== '');
      busContainer.innerHTML = activeBuses.map(b => `
        <div class="mixer-channel">
          <div class="channel-name" title="${b.name}">${b.name}</div>
          <div class="channel-volume">${Math.round(b.volume * 100)}%</div>
          <button class="channel-mute ${b.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-bus="${b.id}">
            ${b.muted === 'muted' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      busContainer.querySelectorAll('[data-mute-bus]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const busId = parseInt(btn.dataset.muteBus);
          const bus = state.buses.find(b => b.id === busId);
          if (bus && bus.muted === 'muted') {
            await X32API.unmuteBus(busId);
          } else {
            await X32API.muteBus(busId);
          }
          setTimeout(() => this.loadMixer(), 500);
        });
      });
    }

    // DCA Groups
    const dcaContainer = document.getElementById('dca-container');
    if (dcaContainer) {
      const activeDcas = state.dcas.filter(d => d.name && d.name.trim() !== '');
      dcaContainer.innerHTML = activeDcas.map(d => `
        <div class="mixer-channel">
          <div class="channel-name" title="${d.name}">${d.name}</div>
          <div class="channel-volume">${Math.round(d.volume * 100)}%</div>
          <button class="channel-mute ${d.muted === 'muted' ? 'muted' : 'unmuted'}" data-mute-dca="${d.id}">
            ${d.muted === 'muted' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      dcaContainer.querySelectorAll('[data-mute-dca]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const dcaId = parseInt(btn.dataset.muteDca);
          const dca = state.dcas.find(d => d.id === dcaId);
          if (dca && dca.muted === 'muted') {
            await X32API.unmuteDca(dcaId);
          } else {
            await X32API.muteDca(dcaId);
          }
          setTimeout(() => this.loadMixer(), 500);
        });
      });
    }
  },

  _wireX32QuickActions() {
    document.getElementById('x32-mute-all')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Mute ALL input channels?')) return;
      const state = X32API.state;
      for (const ch of state.channels) {
        if (ch.name && ch.name.trim() !== '' && ch.muted !== 'muted') {
          await X32API.muteChannel(ch.id);
        }
      }
      App.showToast('All channels muted');
      setTimeout(() => this.loadMixer(), 500);
    });

    document.getElementById('x32-unmute-all')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Unmute ALL input channels?')) return;
      const state = X32API.state;
      for (const ch of state.channels) {
        if (ch.name && ch.name.trim() !== '' && ch.muted === 'muted') {
          await X32API.unmuteChannel(ch.id);
        }
      }
      App.showToast('All channels unmuted');
      setTimeout(() => this.loadMixer(), 500);
    });

    document.getElementById('x32-reload-scene')?.addEventListener('click', async () => {
      const scene = X32API.state.currentScene;
      if (!scene && scene !== 0) {
        App.showToast('No active scene to reload', 2000, 'error');
        return;
      }
      await X32API.loadScene(parseInt(scene));
      App.showToast('Reloading current scene...');
      setTimeout(() => this.loadMixer(), 1000);
    });

    document.getElementById('x32-mute-band')?.addEventListener('click', async () => {
      const musicPatterns = /guitar|bass|drum|key|piano|organ|band|music|inst|synth/i;
      const state = X32API.state;
      const musicChs = state.channels.filter(ch => ch.name && musicPatterns.test(ch.name));
      if (musicChs.length === 0) {
        App.showToast('No music/band channels found', 2000);
        return;
      }
      const anyUnmuted = musicChs.some(ch => ch.muted !== 'muted');
      const action = anyUnmuted ? 'Mute' : 'Unmute';
      if (!await App.showConfirm(`${action} ${musicChs.length} music/band channels?`)) return;
      for (const ch of musicChs) {
        if (anyUnmuted) {
          if (ch.muted !== 'muted') await X32API.muteChannel(ch.id);
        } else {
          if (ch.muted === 'muted') await X32API.unmuteChannel(ch.id);
        }
      }
      App.showToast(`Music channels ${action.toLowerCase()}d`);
      setTimeout(() => this.loadMixer(), 500);
    });
  },

  async _initAnnouncements() {
    this._announcementsLoaded = true;
    this._announceConfig = null;

    // Load announcement config from gateway
    try {
      const resp = await fetch('/api/announcements/config', {
        signal: AbortSignal.timeout(10000),
      });
      this._announceConfig = await resp.json();
    } catch (e) {
      console.error('Failed to load announcement config:', e);
      this._announceConfig = { defaults: {}, presets: {}, sequences: {}, voices: [] };
    }

    const cfg = this._announceConfig;

    // Populate voice selector
    const voiceSelect = document.getElementById('announce-voice-select');
    if (voiceSelect && cfg.voices) {
      const savedVoice = localStorage.getItem('stp_announce_voice') || cfg.defaults?.voice || '';
      voiceSelect.innerHTML = cfg.voices.map(v =>
        `<option value="${v.id}" ${v.id === savedVoice ? 'selected' : ''}>${v.name} (${v.gender}, ${v.locale})</option>`
      ).join('');
      voiceSelect.addEventListener('change', () => {
        localStorage.setItem('stp_announce_voice', voiceSelect.value);
      });
    }

    // Sub-tab switching
    document.querySelectorAll('[data-announce-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.announceTab;
        document.querySelectorAll('[data-announce-tab]').forEach(t => t.classList.toggle('active', t.dataset.announceTab === target));
        document.getElementById('announce-tab-presets').style.display = target === 'presets' ? '' : 'none';
        document.getElementById('announce-tab-sequences').style.display = target === 'sequences' ? '' : 'none';
        document.getElementById('announce-tab-custom').style.display = target === 'custom' ? '' : 'none';
      });
    });

    this._renderPresets(cfg.presets || {});
    this._renderSequences(cfg.sequences || {});
    this._wireCustomAnnounce();
    this._wireFileUpload();
    this._listenAnnounceProgress();
    this._renderAnnounceLog();

    document.getElementById('btn-announce-clear-log')?.addEventListener('click', () => {
      this._announceLog = [];
      this._renderAnnounceLog();
    });
  },

  _getSelectedVoice() {
    return document.getElementById('announce-voice-select')?.value || 'en-US-AndrewNeural';
  },

  _renderPresets(presets) {
    const grid = document.getElementById('announce-presets-grid');
    if (!grid) return;

    if (!Object.keys(presets).length) {
      grid.innerHTML = '<div class="text-center" style="opacity:0.5;">No presets configured</div>';
      return;
    }

    grid.innerHTML = Object.entries(presets).map(([key, preset]) => `
      <button class="announce-preset-btn" data-preset="${key}" title="${preset.text || ''}">
        <span class="material-icons announce-preset-icon">${preset.icon || 'campaign'}</span>
        <span class="announce-preset-label">${preset.label || key}</span>
      </button>
    `).join('');

    grid.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => this._playPreset(btn.dataset.preset));
    });
  },

  async _playPreset(presetKey) {
    const preset = this._announceConfig?.presets?.[presetKey];
    if (!preset) return;

    if (!await App.showConfirm(`Broadcast this announcement?\n\n"${preset.text}"`)) return;

    const btn = document.querySelector(`[data-preset="${presetKey}"]`);
    if (btn) btn.classList.add('announcing');

    this._logAnnounce('Preset', `"${preset.label}" — sending...`, 'pending');

    try {
      const resp = await fetch(`/api/announcements/preset/${presetKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: this._getSelectedVoice() }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();
      if (data.success) {
        this._announceLog[0].status = 'ok';
        this._announceLog[0].detail = `"${preset.label}" (${data.voice || 'default'}, ${data.size || '?'} bytes)`;
        this._renderAnnounceLog();
        App.showToast(`Announced: ${preset.label}`, 3000);
      } else {
        this._announceLog[0].status = 'error';
        this._announceLog[0].error = data.error || 'Unknown error';
        this._renderAnnounceLog();
        App.showToast(`Failed: ${data.error || 'Unknown error'}`, 5000);
      }
    } catch (e) {
      this._logAnnounce('Preset', `"${preset.label}"`, 'error', e.message || 'Network error');
      App.showToast('Announcement failed — network error', 4000);
    } finally {
      if (btn) btn.classList.remove('announcing');
    }
  },

  _renderSequences(sequences) {
    const container = document.getElementById('announce-sequences-list');
    if (!container) return;

    if (!Object.keys(sequences).length) {
      container.innerHTML = '<div class="text-center" style="opacity:0.5;">No sequences configured</div>';
      return;
    }

    container.innerHTML = Object.entries(sequences).map(([key, seq]) => {
      const stepsHtml = (seq.steps || []).map((step, i) => {
        if (step.type === 'announce') {
          return `<div class="announce-seq-step" data-step="${i}">
            <span class="material-icons" style="font-size:14px;color:var(--accent);">campaign</span>
            <span>"${step.text}"</span>
          </div>`;
        }
        if (step.type === 'delay') {
          const label = step.minutes ? `${step.minutes} min` : `${step.seconds || 0}s`;
          return `<div class="announce-seq-step" data-step="${i}">
            <span class="material-icons" style="font-size:14px;color:var(--text-secondary);">hourglass_empty</span>
            <span>Wait ${label}</span>
          </div>`;
        }
        return '';
      }).join('');

      return `
        <div class="announce-sequence-card" data-sequence="${key}">
          <div class="announce-seq-header">
            <div class="announce-seq-info">
              <span class="material-icons" style="font-size:20px;">${seq.icon || 'playlist_play'}</span>
              <div>
                <div class="announce-seq-title">${seq.label || key}</div>
                ${seq.description ? `<div class="announce-seq-desc">${seq.description}</div>` : ''}
              </div>
            </div>
            <div class="announce-seq-actions">
              <button class="btn announce-seq-play-btn" data-seq-play="${key}" title="Start sequence">
                <span class="material-icons">play_arrow</span>
              </button>
              <button class="btn announce-seq-cancel-btn" data-seq-cancel="${key}" title="Cancel sequence" style="display:none;">
                <span class="material-icons">stop</span>
              </button>
            </div>
          </div>
          <div class="announce-seq-steps">${stepsHtml}</div>
          <div class="announce-seq-progress" id="seq-progress-${key}" style="display:none;">
            <div class="announce-seq-progress-bar"><div class="announce-seq-progress-fill" id="seq-fill-${key}"></div></div>
            <div class="announce-seq-progress-text" id="seq-status-${key}"></div>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('[data-seq-play]').forEach(btn => {
      btn.addEventListener('click', () => this._playSequence(btn.dataset.seqPlay));
    });
    container.querySelectorAll('[data-seq-cancel]').forEach(btn => {
      btn.addEventListener('click', () => this._cancelSequence(btn.dataset.seqCancel));
    });
  },

  async _playSequence(sequenceKey) {
    const seq = this._announceConfig?.sequences?.[sequenceKey];
    if (!seq) return;

    if (!await App.showConfirm(`Run announcement sequence?\n\n${seq.label}\n(${seq.steps?.length || 0} steps)`)) return;

    // Show progress, swap play/cancel buttons
    const playBtn = document.querySelector(`[data-seq-play="${sequenceKey}"]`);
    const cancelBtn = document.querySelector(`[data-seq-cancel="${sequenceKey}"]`);
    const progress = document.getElementById(`seq-progress-${sequenceKey}`);
    if (playBtn) playBtn.style.display = 'none';
    if (cancelBtn) cancelBtn.style.display = '';
    if (progress) progress.style.display = '';

    this._logAnnounce('Sequence', `"${seq.label}" — starting (${seq.steps?.length || 0} steps)`, 'pending');

    try {
      const resp = await fetch(`/api/announcements/sequence/${sequenceKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: this._getSelectedVoice() }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (data.success) {
        this._announceLog[0].status = 'ok';
        this._announceLog[0].detail = `"${seq.label}" — running`;
        this._renderAnnounceLog();
      } else {
        this._announceLog[0].status = 'error';
        this._announceLog[0].error = data.error;
        this._renderAnnounceLog();
        App.showToast(`Failed to start sequence: ${data.error}`, 5000);
        if (playBtn) playBtn.style.display = '';
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (progress) progress.style.display = 'none';
      }
    } catch (e) {
      this._logAnnounce('Sequence', `"${seq.label}"`, 'error', e.message || 'Network error');
      App.showToast('Failed to start sequence — network error', 4000);
      if (playBtn) playBtn.style.display = '';
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (progress) progress.style.display = 'none';
    }
  },

  async _cancelSequence(sequenceKey) {
    try {
      await fetch(`/api/announcements/sequence/${sequenceKey}/cancel`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      App.showToast('Cancelling sequence...', 2000);
    } catch (e) {
      App.showToast('Failed to cancel', 3000);
    }
  },

  _listenAnnounceProgress() {
    if (this._announceProgressBound) return;
    this._announceProgressBound = true;

    App.socket?.on('announce:progress', (data) => {
      if (data.type !== 'sequence') return;
      const key = data.sequence;
      const playBtn = document.querySelector(`[data-seq-play="${key}"]`);
      const cancelBtn = document.querySelector(`[data-seq-cancel="${key}"]`);
      const progress = document.getElementById(`seq-progress-${key}`);
      const fill = document.getElementById(`seq-fill-${key}`);
      const status = document.getElementById(`seq-status-${key}`);

      if (!progress) return;

      const total = data.steps_total || 1;
      const completed = data.steps_completed || 0;
      const pct = Math.round((completed / total) * 100);

      if (fill) fill.style.width = `${pct}%`;
      if (status) status.textContent = data.current_step || data.status;

      // Highlight active step
      const card = document.querySelector(`[data-sequence="${key}"]`);
      if (card) {
        card.querySelectorAll('.announce-seq-step').forEach((el, i) => {
          el.classList.toggle('active-step', i === completed);
          el.classList.toggle('completed-step', i < completed);
        });
      }

      if (data.status === 'completed' || data.status === 'failed' || data.status === 'cancelled') {
        if (playBtn) playBtn.style.display = '';
        if (cancelBtn) cancelBtn.style.display = 'none';

        if (data.status === 'completed') {
          if (fill) fill.style.width = '100%';
          if (status) status.textContent = 'Completed';
          this._logAnnounce('Sequence', `"${data.label}" completed (${data.steps_completed}/${data.steps_total} steps)`);
          App.showToast('Announcement sequence completed', 3000);
        } else if (data.status === 'cancelled') {
          if (status) status.textContent = 'Cancelled';
          this._logAnnounce('Sequence', `"${data.label}" cancelled`, 'error', 'Cancelled by user');
          App.showToast('Sequence cancelled', 2000);
        } else {
          if (status) status.textContent = `Failed: ${data.error || ''}`;
          this._logAnnounce('Sequence', `"${data.label}" failed`, 'error', data.error);
          App.showToast(`Sequence failed: ${data.error || 'Unknown error'}`, 5000);
        }

        // Reset step highlighting
        if (card) {
          card.querySelectorAll('.announce-seq-step').forEach(el => {
            el.classList.remove('active-step');
            if (data.status === 'completed') el.classList.add('completed-step');
          });
        }

        // Hide progress after delay
        setTimeout(() => {
          if (progress) progress.style.display = 'none';
          if (card) {
            card.querySelectorAll('.announce-seq-step').forEach(el => {
              el.classList.remove('completed-step', 'active-step');
            });
          }
        }, 5000);
      }
    });
  },

  _wireCustomAnnounce() {
    document.getElementById('btn-announce-custom')?.addEventListener('click', async () => {
      const text = document.getElementById('announce-custom-text')?.value?.trim();
      if (!text) {
        App.showToast('Please type a message first', 2000);
        return;
      }
      if (!await App.showConfirm(`Broadcast this announcement?\n\n"${text}"`)) return;

      const shortText = text.length > 50 ? text.substring(0, 50) + '...' : text;
      this._logAnnounce('Custom', `"${shortText}" — sending...`, 'pending');

      try {
        const resp = await fetch('/api/announcements/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: this._getSelectedVoice() }),
          signal: AbortSignal.timeout(30000),
        });
        const data = await resp.json();
        if (data.success) {
          this._announceLog[0].status = 'ok';
          this._announceLog[0].detail = `"${shortText}" (${data.voice || 'default'}, ${data.size || '?'} bytes)`;
          this._renderAnnounceLog();
          App.showToast('Announcement sent!', 3000);
          document.getElementById('announce-custom-text').value = '';
        } else {
          this._announceLog[0].status = 'error';
          this._announceLog[0].error = data.error || 'Unknown error';
          this._renderAnnounceLog();
          App.showToast(`Failed: ${data.error || 'Unknown error'}`, 5000);
        }
      } catch (e) {
        this._logAnnounce('Custom', `"${shortText}"`, 'error', e.message || 'Network error');
        App.showToast('Announcement failed — network error', 4000);
      }
    });
  },

  _wireFileUpload() {
    const fileInput = document.getElementById('announce-file-input');
    const fileName = document.getElementById('announce-file-name');
    const playBtn = document.getElementById('btn-announce-play-file');

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) {
        fileName.textContent = file.name;
        playBtn.disabled = false;
      } else {
        fileName.textContent = 'No file selected';
        playBtn.disabled = true;
      }
    });

    playBtn?.addEventListener('click', async () => {
      const file = fileInput?.files?.[0];
      if (!file) return;

      const formData = new FormData();
      formData.append('file', file);
      formData.append('play', 'true');

      try {
        playBtn.disabled = true;
        const resp = await fetch('/api/announcements/upload', {
          method: 'POST',
          body: formData,
          signal: AbortSignal.timeout(30000),
        });
        const data = await resp.json();
        if (data.played) {
          this._logAnnounce('Upload', `"${file.name}" (${data.size || '?'} bytes) — playing`);
          App.showToast(`Playing: ${file.name}`, 3000);
        } else if (data.play_error) {
          this._logAnnounce('Upload', `"${file.name}"`, 'error', data.play_error);
          App.showToast(`Uploaded but playback failed: ${data.play_error}`, 5000);
        } else if (data.error) {
          this._logAnnounce('Upload', `"${file.name}"`, 'error', data.error);
          App.showToast(`Upload failed: ${data.error}`, 5000);
        } else {
          this._logAnnounce('Upload', `"${file.name}" cached (${data.size || '?'} bytes)`);
          App.showToast('File uploaded', 2000);
        }
      } catch (e) {
        App.showToast('Upload failed — network error', 4000);
      } finally {
        playBtn.disabled = false;
      }
    });
  },

  // ---- ANNOUNCEMENT ACTIVITY LOG ----

  _logAnnounce(action, detail, status = 'ok', error = null) {
    this._announceLog.unshift({
      time: new Date().toLocaleTimeString(),
      action,
      detail,
      status,
      error,
    });
    // Keep last 50 entries
    if (this._announceLog.length > 50) this._announceLog.length = 50;
    this._renderAnnounceLog();
  },

  _renderAnnounceLog() {
    const container = document.getElementById('announce-log-container');
    if (!container) return;

    if (this._announceLog.length === 0) {
      container.innerHTML = '<div class="text-center" style="opacity:0.4;">No announcements yet</div>';
      return;
    }

    container.innerHTML = this._announceLog.map(e => {
      const icon = e.status === 'ok' ? '&#10003;' : e.status === 'pending' ? '&#8230;' : '&#10007;';
      const color = e.status === 'ok' ? '#00b050' : e.status === 'error' ? '#cc0000' : '#f0a030';
      const err = e.error ? ` &mdash; ${e.error}` : '';
      return `<div style="padding:4px 8px;border-bottom:1px solid var(--border);color:${color};">
        <span>${icon}</span>
        <span style="color:var(--text-secondary);">${e.time}</span>
        <strong>${e.action}</strong>
        &rarr; ${e.detail}${err}
      </div>`;
    }).join('');
  },

  // ---- TEST PANEL ----

  async _initTestPanel() {
    this._testLoaded = true;
    const container = document.getElementById('test-container');
    if (!container) return;

    // Load notify entities from HA for device targeting options
    let notifyEntities = [];
    try {
      const resp = await fetch('/api/ha/entities?domain=notify&q=alexa', {
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      notifyEntities = (data.domains?.notify?.entities || []).filter(e =>
        /alexa|echo/i.test(e.entity_id) || /alexa|echo/i.test(e.friendly_name || '')
      );
    } catch (e) {
      console.error('Failed to load notify entities:', e);
    }

    // Load automation presets (for legacy test methods)
    let legacyAutomations = [];
    {
      try {
        const resp = await fetch('/api/ha/entities?domain=automation&q=alexaannounce', {
          signal: AbortSignal.timeout(10000),
        });
        const data = await resp.json();
        const entities = data.domains?.automation?.entities || [];
        legacyAutomations = entities.filter(e =>
          e.entity_id.startsWith('automation.automation_alexaannounce_')
        );
      } catch (e) {
        legacyAutomations = [];
      }
    }

    const notifyOptions = notifyEntities.map(e => {
      const label = e.friendly_name || e.entity_id;
      return `<option value="${e.entity_id}">${label}</option>`;
    }).join('');

    const automationOptions = legacyAutomations.map(a => {
      const label = a.friendly_name || a.entity_id.replace('automation.automation_alexaannounce_', '').replace(/_/g, ' ');
      return `<option value="${a.entity_id}">${label}</option>`;
    }).join('');

    container.innerHTML = `
      <div class="announce-form" style="max-width:600px;">
        <label class="announce-label">Test Message</label>
        <input type="text" id="test-message" class="announce-textarea" style="min-height:auto;padding:8px 10px;"
          value="This is a test announcement" />

        <label class="announce-label" style="margin-top:12px;">Target Notify Entity</label>
        <select id="test-notify-entity" class="routing-select" style="width:100%;margin-bottom:12px;">
          <option value="notify.av_room_echo_dot_announce">notify.av_room_echo_dot_announce (current default)</option>
          ${notifyOptions}
        </select>

        <div class="test-methods-grid">
          <div class="test-method-card">
            <div class="test-method-title">Method 1: notify/send_message</div>
            <div class="test-method-desc">Direct HA notify — select _announce or _speak entity above</div>
            <button class="btn test-btn" data-test="notify_send_message">
              <span class="material-icons">send</span>
              <span class="btn-label">Test</span>
            </button>
          </div>

          <div class="test-method-card">
            <div class="test-method-title">Method 2: automation/trigger</div>
            <div class="test-method-desc">Current preset path — triggers an HA automation</div>
            <select id="test-automation-select" class="routing-select" style="width:100%;margin-bottom:6px;font-size:12px;">
              <option value="">-- Select Automation --</option>
              ${automationOptions}
            </select>
            <button class="btn test-btn" data-test="automation_trigger">
              <span class="material-icons">send</span>
              <span class="btn-label">Test</span>
            </button>
          </div>

          <div class="test-method-card">
            <div class="test-method-title">Method 3: script/turn_on</div>
            <div class="test-method-desc">Call an HA script instead of automation (if configured)</div>
            <input type="text" id="test-script-entity" class="announce-textarea" style="min-height:auto;padding:6px 8px;font-size:12px;"
              placeholder="script.alexa_announce_test" />
            <button class="btn test-btn" data-test="script_turn_on" style="margin-top:4px;">
              <span class="material-icons">send</span>
              <span class="btn-label">Test</span>
            </button>
          </div>
        </div>

        <div style="margin-top:16px;display:flex;gap:8px;">
          <button class="btn" id="btn-test-clear-log" style="max-width:160px;">
            <span class="material-icons">delete_sweep</span>
            <span class="btn-label">Clear Log</span>
          </button>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);">
            <input type="checkbox" id="test-unmute-aux" checked />
            Unmute Aux 3 & 4 before test
          </label>
        </div>
      </div>
    `;

    // Wire up test buttons
    container.querySelectorAll('.test-btn').forEach(btn => {
      btn.addEventListener('click', () => this._runTest(btn.dataset.test));
    });

    document.getElementById('btn-test-clear-log')?.addEventListener('click', () => {
      this._testLog = [];
      this._renderTestLog();
    });
  },

  async _runTest(method) {
    const message = document.getElementById('test-message')?.value?.trim();
    const notifyEntity = document.getElementById('test-notify-entity')?.value;
    const unmuteAux = document.getElementById('test-unmute-aux')?.checked;

    if (!message && method !== 'automation_trigger') {
      App.showToast('Enter a test message first', 2000);
      return;
    }

    const entry = {
      time: new Date().toLocaleTimeString(),
      method,
      message: message || '(automation preset)',
      entity: notifyEntity,
      status: 'pending',
      latency: null,
      error: null,
    };

    this._testLog.unshift(entry);
    this._renderTestLog();

    try {
      if (unmuteAux) {
        await Promise.all([X32API.unmuteAux(3), X32API.unmuteAux(4)]);
      }

      const start = performance.now();
      let resp;

      switch (method) {
        case 'notify_send_message':
          resp = await fetch('/api/ha/service/notify/send_message', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: notifyEntity, message }),
            signal: AbortSignal.timeout(15000),
          });
          break;

        case 'automation_trigger': {
          const autoId = document.getElementById('test-automation-select')?.value;
          if (!autoId) {
            entry.status = 'error';
            entry.error = 'No automation selected';
            this._renderTestLog();
            return;
          }
          entry.message = autoId.replace('automation.automation_alexaannounce_', '');
          resp = await fetch('/api/ha/service/automation/trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: autoId }),
            signal: AbortSignal.timeout(15000),
          });
          break;
        }

        case 'script_turn_on': {
          const scriptId = document.getElementById('test-script-entity')?.value?.trim();
          if (!scriptId) {
            entry.status = 'error';
            entry.error = 'Enter a script entity ID';
            this._renderTestLog();
            return;
          }
          entry.entity = scriptId;
          resp = await fetch('/api/ha/service/script/turn_on', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: scriptId }),
            signal: AbortSignal.timeout(15000),
          });
          break;
        }

        default:
          entry.status = 'error';
          entry.error = 'Unknown method';
          this._renderTestLog();
          return;
      }

      entry.latency = Math.round(performance.now() - start);
      const body = await resp.json().catch(() => null);

      if (resp.ok) {
        entry.status = 'ok';
        App.showToast(`Test sent (${entry.latency}ms)`, 2000);
      } else {
        entry.status = 'error';
        entry.error = body?.error || body?.message || `HTTP ${resp.status}`;
      }
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message || 'Network error';
    }

    this._renderTestLog();
  },

  _renderTestLog() {
    const container = document.getElementById('test-log-container');
    if (!container) return;

    if (this._testLog.length === 0) {
      container.innerHTML = '<div class="text-center" style="opacity:0.4;">No tests run yet</div>';
      return;
    }

    container.innerHTML = this._testLog.map(e => {
      const icon = e.status === 'ok' ? '✓' : e.status === 'error' ? '✗' : '…';
      const color = e.status === 'ok' ? '#00b050' : e.status === 'error' ? '#cc0000' : '#888';
      const latency = e.latency != null ? ` (${e.latency}ms)` : '';
      const err = e.error ? ` — ${e.error}` : '';
      return `<div style="padding:4px 8px;border-bottom:1px solid var(--border);color:${color};">
        <span>${icon}</span>
        <span style="color:var(--text-secondary);">${e.time}</span>
        <strong>${e.method}</strong>
        → ${e.message}${latency}${err}
      </div>`;
    }).join('');
  },

  // ---- WIIM PRO PANEL ----

  async _initWiimPanel() {
    this._wiimLoaded = true;
    const container = document.getElementById('wiim-container');
    if (!container) return;

    // Fetch current state
    let state = null;
    try {
      const resp = await fetch(`/api/ha/states/${this._wiimEntity}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) state = await resp.json();
    } catch (e) {
      console.error('Failed to fetch WiiM state:', e);
    }

    const stateStr = state?.state || 'unknown';
    const volume = state?.attributes?.volume_level != null
      ? Math.round(state.attributes.volume_level * 100)
      : '—';
    const source = state?.attributes?.source || '—';
    const friendly = state?.attributes?.friendly_name || this._wiimEntity;
    const mediaTitle = state?.attributes?.media_title || '—';

    container.innerHTML = `
      <div class="announce-form" style="max-width:600px;">
        <!-- Status bar -->
        <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;margin-bottom:12px;">
          <span class="material-icons" style="font-size:20px;color:${stateStr === 'playing' ? '#00b050' : stateStr === 'idle' || stateStr === 'on' ? '#f0a030' : '#888'};">
            ${stateStr === 'playing' ? 'play_circle' : stateStr === 'paused' ? 'pause_circle' : 'speaker'}
          </span>
          <div style="flex:1;">
            <div style="font-size:13px;font-weight:600;">${friendly}</div>
            <div style="font-size:11px;color:var(--text-secondary);">
              State: <strong>${stateStr}</strong> &nbsp;|&nbsp; Volume: <strong id="wiim-vol-display">${volume}%</strong> &nbsp;|&nbsp; Source: ${source} &nbsp;|&nbsp; Now playing: ${mediaTitle}
            </div>
          </div>
          <button class="btn" id="btn-wiim-refresh" style="min-width:36px;padding:6px;" title="Refresh state">
            <span class="material-icons" style="font-size:18px;">refresh</span>
          </button>
        </div>

        <!-- Volume control -->
        <label class="announce-label">Volume</label>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">
          <input type="range" id="wiim-volume" min="0" max="100" value="${volume !== '—' ? volume : 30}" style="flex:1;" />
          <span id="wiim-vol-slider-val" style="font-size:13px;min-width:36px;text-align:right;">${volume !== '—' ? volume : 30}%</span>
          <button class="btn" id="btn-wiim-set-vol" style="min-width:80px;padding:6px 10px;">
            <span class="material-icons" style="font-size:16px;">volume_up</span>
            <span class="btn-label">Set</span>
          </button>
        </div>

        <!-- Transport controls -->
        <label class="announce-label">Transport</label>
        <div class="test-methods-grid" style="margin-bottom:12px;">
          <button class="btn" id="btn-wiim-play" style="flex:1;">
            <span class="material-icons">play_arrow</span>
            <span class="btn-label">Play</span>
          </button>
          <button class="btn" id="btn-wiim-pause" style="flex:1;">
            <span class="material-icons">pause</span>
            <span class="btn-label">Pause</span>
          </button>
          <button class="btn" id="btn-wiim-stop" style="flex:1;">
            <span class="material-icons">stop</span>
            <span class="btn-label">Stop</span>
          </button>
          <button class="btn" id="btn-wiim-mute" style="flex:1;">
            <span class="material-icons">volume_off</span>
            <span class="btn-label">Mute</span>
          </button>
          <button class="btn" id="btn-wiim-unmute" style="flex:1;">
            <span class="material-icons">volume_up</span>
            <span class="btn-label">Unmute</span>
          </button>
        </div>

        <!-- TTS Announcement -->
        <label class="announce-label">TTS Announcement</label>
        <div style="margin-bottom:8px;">
          <select id="wiim-tts-voice" class="routing-select" style="width:100%;margin-bottom:6px;">
            <option value="en-US-AndrewNeural">Andrew (Male, US)</option>
            <option value="en-US-GuyNeural">Guy (Male, US)</option>
            <option value="en-US-JennyNeural">Jenny (Female, US)</option>
            <option value="en-US-AriaNeural">Aria (Female, US)</option>
            <option value="en-US-DavisNeural">Davis (Male, US)</option>
            <option value="en-GB-RyanNeural">Ryan (Male, UK)</option>
            <option value="en-GB-SoniaNeural">Sonia (Female, UK)</option>
          </select>
          <input type="text" id="wiim-tts-message" class="announce-textarea" style="min-height:auto;padding:8px 10px;"
            value="This is a test announcement from the WiiM Pro" />
        </div>
        <button class="btn" id="btn-wiim-tts-proxy" style="max-width:200px;margin-bottom:12px;">
          <span class="material-icons">record_voice_over</span>
          <span class="btn-label">Send TTS</span>
        </button>

        <!-- Announce option for play_media -->
        <div style="margin-bottom:12px;">
          <label style="font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;">
            <input type="checkbox" id="wiim-announce-mode" />
            <span>Use <code>announce: true</code> on play_media (ducks current audio, resumes after)</span>
          </label>
        </div>

        <!-- Play URL -->
        <label class="announce-label" style="margin-top:12px;">Play Media URL</label>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input type="text" id="wiim-media-url" class="announce-textarea" style="min-height:auto;padding:8px 10px;flex:1;"
            placeholder="https://example.com/audio.mp3" />
          <button class="btn" id="btn-wiim-play-url" style="min-width:80px;padding:6px 10px;">
            <span class="material-icons">play_circle</span>
            <span class="btn-label">Play</span>
          </button>
        </div>
      </div>
    `;

    // Wire up event handlers
    this._wireWiimHandlers();
  },

  _wireWiimHandlers() {
    const entity = this._wiimEntity;

    // Volume slider display
    document.getElementById('wiim-volume')?.addEventListener('input', (e) => {
      document.getElementById('wiim-vol-slider-val').textContent = e.target.value + '%';
    });

    // Refresh
    document.getElementById('btn-wiim-refresh')?.addEventListener('click', async () => {
      this._wiimLoaded = false;
      await this._initWiimPanel();
      this._logWiimTest('refresh', 'Refreshed state');
    });

    // Set volume
    document.getElementById('btn-wiim-set-vol')?.addEventListener('click', () => {
      const vol = parseInt(document.getElementById('wiim-volume')?.value || '30', 10);
      this._callWiimService('media_player', 'volume_set', {
        entity_id: entity,
        volume_level: vol / 100,
      }, `volume_set → ${vol}%`);
    });

    // Transport buttons
    document.getElementById('btn-wiim-play')?.addEventListener('click', () => {
      this._callWiimService('media_player', 'media_play', { entity_id: entity }, 'media_play');
    });
    document.getElementById('btn-wiim-pause')?.addEventListener('click', () => {
      this._callWiimService('media_player', 'media_pause', { entity_id: entity }, 'media_pause');
    });
    document.getElementById('btn-wiim-stop')?.addEventListener('click', () => {
      this._callWiimService('media_player', 'media_stop', { entity_id: entity }, 'media_stop');
    });
    document.getElementById('btn-wiim-mute')?.addEventListener('click', () => {
      this._callWiimService('media_player', 'volume_mute', {
        entity_id: entity, is_volume_muted: true,
      }, 'mute');
    });
    document.getElementById('btn-wiim-unmute')?.addEventListener('click', () => {
      this._callWiimService('media_player', 'volume_mute', {
        entity_id: entity, is_volume_muted: false,
      }, 'unmute');
    });

    // TTS via Gateway (edge-tts generates audio on gateway, plays via media_player)
    document.getElementById('btn-wiim-tts-proxy')?.addEventListener('click', async () => {
      const message = document.getElementById('wiim-tts-message')?.value?.trim();
      if (!message) { App.showToast('Enter a TTS message', 2000); return; }
      const voice = document.getElementById('wiim-tts-voice')?.value || 'en-US-GuyNeural';
      const announce = document.getElementById('wiim-announce-mode')?.checked || false;
      const label = `TTS: "${message.substring(0, 40)}${message.length > 40 ? '…' : ''}" (${voice})`;

      const entry = {
        time: new Date().toLocaleTimeString(),
        method: 'wiim/tts',
        message: label,
        entity: this._wiimEntity,
        status: 'pending',
        latency: null,
        error: null,
      };
      this._testLog.unshift(entry);
      this._renderTestLog();

      try {
        const start = performance.now();

        // Step 1: Generate TTS audio on gateway via edge-tts
        const genResp = await fetch('/api/tts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, voice }),
          signal: AbortSignal.timeout(20000),
        });
        const genData = await genResp.json().catch(() => null);
        if (!genResp.ok) {
          entry.status = 'error';
          entry.latency = Math.round(performance.now() - start);
          entry.error = (genData?.error || `Generate failed: HTTP ${genResp.status}`) +
            (genData?.detail ? ` | ${genData.detail}` : '');
          this._renderTestLog();
          return;
        }

        // Step 2: Build full URL the WiiM can reach (gateway address)
        const audioPath = genData.url; // e.g. /api/tts/audio/abc123.mp3
        const gatewayOrigin = window.location.origin; // e.g. http://192.168.1.X:20858
        const fullAudioUrl = gatewayOrigin + audioPath;

        // Step 3: Tell WiiM to play the gateway-hosted audio
        const playData = {
          entity_id: entity,
          media_content_id: fullAudioUrl,
          media_content_type: 'music',
        };
        if (announce) playData.announce = true;

        const playResp = await fetch('/api/ha/service/media_player/play_media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(playData),
          signal: AbortSignal.timeout(15000),
        });

        entry.latency = Math.round(performance.now() - start);
        if (playResp.ok) {
          entry.status = 'ok';
          entry.message = `${label} → ${fullAudioUrl} (${genData.size} bytes)`;
          App.showToast(`TTS proxy OK (${entry.latency}ms)`, 2000);
        } else {
          const playBody = await playResp.json().catch(() => null);
          entry.status = 'error';
          entry.error = playBody?.error || `play_media failed: HTTP ${playResp.status}`;
        }
      } catch (e) {
        entry.status = 'error';
        entry.error = e.message || 'Network error';
      }
      this._renderTestLog();
    });

    // Play URL
    document.getElementById('btn-wiim-play-url')?.addEventListener('click', () => {
      const url = document.getElementById('wiim-media-url')?.value?.trim();
      if (!url) { App.showToast('Enter a media URL', 2000); return; }
      const announce = document.getElementById('wiim-announce-mode')?.checked || false;
      const playData = {
        entity_id: entity,
        media_content_id: url,
        media_content_type: 'music',
      };
      if (announce) playData.announce = true;
      this._callWiimService('media_player', 'play_media', playData,
        `play_media${announce ? ' (announce)' : ''}: ${url.substring(0, 50)}`);
    });
  },

  async _callWiimService(domain, service, data, label) {
    const entry = {
      time: new Date().toLocaleTimeString(),
      method: `wiim/${service}`,
      message: label,
      entity: this._wiimEntity,
      status: 'pending',
      latency: null,
      error: null,
    };
    this._testLog.unshift(entry);
    this._renderTestLog();

    try {
      const start = performance.now();
      const resp = await fetch(`/api/ha/service/${domain}/${service}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(15000),
      });
      entry.latency = Math.round(performance.now() - start);
      const body = await resp.json().catch(() => null);

      if (resp.ok) {
        entry.status = 'ok';
        App.showToast(`WiiM ${service} OK (${entry.latency}ms)`, 2000);
      } else {
        entry.status = 'error';
        entry.error = body?.error || body?.message || `HTTP ${resp.status}`;
      }
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message || 'Network error';
    }

    this._renderTestLog();
  },

  _logWiimTest(method, message) {
    this._testLog.unshift({
      time: new Date().toLocaleTimeString(),
      method: `wiim/${method}`,
      message,
      entity: this._wiimEntity,
      status: 'ok',
      latency: null,
      error: null,
    });
    this._renderTestLog();
  },

  async loadRouting() {
    const state = await MoIPAPI.poll();
    this._renderRouting(state);
  },

  _renderRouting(state) {
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
            <div style="display:flex;gap:6px;align-items:center;">
              <select class="routing-select" data-rx="${rx.id}" style="flex:1;">
                <option value="">-- Select Source --</option>
                ${this.transmitters.map(tx => `<option value="${tx.id}" ${String(currentTx) === String(tx.id) ? 'selected' : ''}>${tx.id} - ${tx.name}</option>`).join('')}
              </select>
              ${this._previewEnabled ? `<button class="btn moip-preview-btn" data-preview-tx="${currentTx}" title="Preview this source" style="min-width:36px;padding:6px;"><span class="material-icons" style="font-size:18px;">visibility</span></button>` : ''}
            </div>
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
          // Update the adjacent preview button's data attribute
          const previewBtn = e.target.parentElement?.querySelector('.moip-preview-btn');
          if (previewBtn) previewBtn.dataset.previewTx = txId;
        }
      });
    });

    // Attach preview button handlers
    container.querySelectorAll('.moip-preview-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const txId = parseInt(btn.dataset.previewTx);
        if (txId) this._openPreview(txId);
      });
    });
  },

  _initPreview() {
    // Show the preview button if enabled
    const previewBtn = document.getElementById('btn-preview-tx');
    if (previewBtn && this._previewEnabled) {
      previewBtn.style.display = 'inline-flex';
      previewBtn.addEventListener('click', () => this._openPreview());
    }

    document.getElementById('btn-preview-close')?.addEventListener('click', () => this._closePreview());
    document.getElementById('btn-preview-switch')?.addEventListener('click', () => {
      const sel = document.getElementById('moip-preview-tx-select');
      if (sel?.value) this._switchPreview(parseInt(sel.value));
    });

    // Close on overlay click (outside modal)
    document.getElementById('moip-preview-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'moip-preview-overlay') this._closePreview();
    });
  },

  _openPreview(txId) {
    const overlay = document.getElementById('moip-preview-overlay');
    if (!overlay) return;

    // Populate transmitter dropdown
    const sel = document.getElementById('moip-preview-tx-select');
    if (sel) {
      sel.innerHTML = this.transmitters.map(tx =>
        `<option value="${tx.id}" ${tx.id === txId ? 'selected' : ''}>${tx.id} - ${tx.name}</option>`
      ).join('');
      if (!txId && this.transmitters.length) txId = this.transmitters[0].id;
    }

    overlay.style.display = 'flex';
    if (txId) this._switchPreview(txId);
  },

  async _switchPreview(txId) {
    const loading = document.getElementById('moip-preview-loading');
    const stream = document.getElementById('moip-preview-stream');
    const error = document.getElementById('moip-preview-error');
    const title = document.getElementById('moip-preview-title');

    // Show loading, hide others
    if (loading) loading.style.display = '';
    if (stream) { stream.style.display = 'none'; stream.src = ''; }
    if (error) error.style.display = 'none';

    try {
      const resp = await fetch('/api/moip/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transmitter: txId }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      if (title) title.textContent = `Preview: TX${txId} - ${data.transmitter_name}`;

      // Wait for signal lock then show stream
      await new Promise(r => setTimeout(r, data.switch_delay_ms || this._previewSwitchDelay));

      if (loading) loading.style.display = 'none';
      if (stream) {
        stream.src = data.stream_url;
        stream.style.display = '';
        stream.onerror = () => {
          stream.style.display = 'none';
          if (error) {
            error.textContent = 'Stream unavailable. Check encoder connection.';
            error.style.display = '';
          }
        };
      }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (error) {
        error.textContent = e.message || 'Failed to start preview';
        error.style.display = '';
      }
    }
  },

  _closePreview() {
    const overlay = document.getElementById('moip-preview-overlay');
    const stream = document.getElementById('moip-preview-stream');
    if (overlay) overlay.style.display = 'none';
    // Disconnect MJPEG stream
    if (stream) { stream.src = ''; stream.style.display = 'none'; }
  },

  _showHelp() {
    App.showPanel('Source Routing - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page provides low-level control over the MoIP video routing matrix and the X32 audio mixer. It is intended for advanced users and troubleshooting.</p>
          </div>

          <div class="help-section">
            <h3>Video Tab</h3>
            <p class="help-note">Shows every MoIP receiver grouped by location. Each receiver has a dropdown to select which transmitter (source) it receives from.</p>
            <dl class="help-list">
              <dt><span class="material-icons">refresh</span> Refresh</dt>
              <dd>Reloads the current routing state from all receivers.</dd>
              <dt>Receiver Dropdowns</dt>
              <dd>Select a transmitter source for each receiver. Changes take effect immediately. Green link icon means the receiver is connected.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Audio Tab - Quick Actions</h3>
            <dl class="help-list">
              <dt><span class="material-icons">volume_off</span> Mute All</dt>
              <dd>Mutes every named input channel on the X32 mixer.</dd>
              <dt><span class="material-icons">volume_up</span> Unmute All</dt>
              <dd>Unmutes every named input channel.</dd>
              <dt><span class="material-icons">refresh</span> Reload Scene</dt>
              <dd>Reloads the currently active mixer scene, resetting all faders and mutes to their saved positions.</dd>
              <dt><span class="material-icons">music_off</span> Mute Music</dt>
              <dd>Toggles mute on all channels identified as music/band channels (guitar, bass, drums, keys, etc.).</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Audio Tab - Mixer Scenes</h3>
            <p class="help-note">Saved mixer presets. Click to load a scene — this resets all channel volumes and mutes to the saved configuration. Requires confirmation.</p>
          </div>

          <div class="help-section">
            <h3>Audio Tab - Input Channels, Buses & DCAs</h3>
            <p class="help-note">Shows individual channel faders with volume sliders and mute buttons. Aux inputs, mix buses, and DCA groups each show mute state and volume levels. Only channels with names assigned on the X32 are shown.</p>
          </div>

          <div class="help-section">
            <h3>Announcements Tab</h3>
            <p class="help-note">Broadcasts voice announcements through the WiiM Pro media player using text-to-speech (TTS). The WiiM feeds into the X32 mixer via Aux 3/4 for church-wide audio.</p>
            <dl class="help-list">
              <dt>Voice Selector</dt>
              <dd>Choose the TTS voice used for all announcements. Your selection is saved and persists across sessions. Uses Microsoft Edge TTS voices.</dd>
              <dt><span class="material-icons">touch_app</span> Presets</dt>
              <dd>One-tap preset announcements (e.g., "Church Closing", "Sunday School Starting"). Defined in announcements.yaml on the gateway. Tap a button, confirm, and the announcement plays immediately.</dd>
              <dt><span class="material-icons">playlist_play</span> Sequences</dt>
              <dd>Multi-step announcement workflows with delays between messages (e.g., "Sunday School Countdown" announces at 20, 10, 5, and 0 minutes). Shows real-time progress with step highlighting and countdown. Sequences can be cancelled mid-run. Can also be triggered from macros.</dd>
              <dt><span class="material-icons">edit_note</span> Custom</dt>
              <dd>Type any text and announce it immediately, or upload an MP3 audio file to play through the WiiM.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Announcements in Macros</h3>
            <p class="help-note">Presets, sequences, and custom text can be used as macro steps in macros.yaml using the <code>tts_announce</code> step type:</p>
            <dl class="help-list">
              <dt>Preset from macro</dt>
              <dd><code>type: tts_announce, preset: church_closing</code></dd>
              <dt>Sequence from macro</dt>
              <dd><code>type: tts_announce, sequence: sunday_school_countdown</code></dd>
              <dt>Inline text from macro</dt>
              <dd><code>type: tts_announce, text: "The liturgy is beginning."</code></dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Test Tab</h3>
            <p class="help-note">Legacy testing tools for comparing announcement delivery methods (Alexa, WiiM) and debugging.</p>
            <dl class="help-list">
              <dt>Announcement Method Testing</dt>
              <dd>Tests various HA notification methods (notify, automation, script).</dd>
              <dt>WiiM Pro Testing</dt>
              <dd>Direct WiiM media player controls: volume, transport, TTS, URL playback.</dd>
              <dt>Test Log</dt>
              <dd>Shows timing and success/failure for each test.</dd>
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
        App.openChat('source');
      });
    });
  },

  destroy() {
    this._closePreview();
    this._activeTab = 'video';
    this._announcementsLoaded = false;
    this._announceConfig = null;
    this._announceProgressBound = false;
    this._announceLog = [];
    this._testLoaded = false;
    this._testLog = [];
  }
};
