const SourcePage = {
  pollTimer: null,
  mixerTimer: null,
  transmitters: [],
  receivers: [],
  _activeTab: 'video',
  _announcementsLoaded: false,
  _announcements: [],

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
        </div>

        <!-- VIDEO TAB -->
        <div id="source-tab-video">
          <div class="text-center" style="margin-bottom:8px;">
            <button class="btn" id="btn-refresh-routing" style="display:inline-flex;max-width:200px;">
              <span class="material-icons">refresh</span>
              <span class="btn-label">Refresh</span>
            </button>
          </div>
          <div id="routing-container">
            <div class="text-center" style="opacity:0.5;">Loading receiver mappings...</div>
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
            <div class="section-title">Bus / Aux Outputs</div>
            <div id="aux-container" class="mixer-grid"></div>
          </div>
        </div>

        <!-- ANNOUNCEMENTS TAB -->
        <div id="source-tab-announcements" style="display:none;">
          <div class="control-section">
            <div class="section-title">Alexa Announcements</div>
            <div id="announce-container">
              <div class="text-center" style="opacity:0.5;">Loading announcements...</div>
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

        if (target === 'audio' && !this.mixerTimer) {
          this._initAudio();
        }
        if (target === 'announcements' && !this._announcementsLoaded) {
          this._initAnnouncements();
        }
      });
    });

    this.loadRouting();
    this.pollTimer = setInterval(() => this.loadRouting(), 10000);

    document.getElementById('btn-refresh-routing')?.addEventListener('click', () => this.loadRouting());
  },

  _initAudio() {
    this.loadMixer();
    this.mixerTimer = setInterval(() => this.loadMixer(), 5000);
    this._wireX32QuickActions();
  },

  async loadMixer() {
    const state = await X32API.poll();
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
            <button class="channel-mute ${ch.muted === 'ON' || ch.muted === '1' ? 'muted' : 'unmuted'}" data-mute-ch="${ch.id}">
              ${ch.muted === 'ON' || ch.muted === '1' ? 'MUTED' : 'ON'}
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
        if (ch && (ch.muted === 'ON' || ch.muted === '1')) {
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
          <button class="channel-mute ${a.muted === 'ON' || a.muted === '1' ? 'muted' : 'unmuted'}" data-mute-aux="${a.id}">
            ${a.muted === 'ON' || a.muted === '1' ? 'MUTED' : 'ON'}
          </button>
        </div>
      `).join('');

      auxContainer.querySelectorAll('[data-mute-aux]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const auxId = parseInt(btn.dataset.muteAux);
          const aux = state.auxChannels.find(a => a.id === auxId);
          if (aux && (aux.muted === 'ON' || aux.muted === '1')) {
            await X32API.unmuteAux(auxId);
          } else {
            await X32API.muteAux(auxId);
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
        if (ch.name && ch.name.trim() !== '' && ch.muted !== 'ON' && ch.muted !== '1') {
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
        if (ch.name && ch.name.trim() !== '' && (ch.muted === 'ON' || ch.muted === '1')) {
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
      const anyUnmuted = musicChs.some(ch => ch.muted !== 'ON' && ch.muted !== '1');
      const action = anyUnmuted ? 'Mute' : 'Unmute';
      if (!await App.showConfirm(`${action} ${musicChs.length} music/band channels?`)) return;
      for (const ch of musicChs) {
        if (anyUnmuted) {
          if (ch.muted !== 'ON' && ch.muted !== '1') await X32API.muteChannel(ch.id);
        } else {
          if (ch.muted === 'ON' || ch.muted === '1') await X32API.unmuteChannel(ch.id);
        }
      }
      App.showToast(`Music channels ${action.toLowerCase()}d`);
      setTimeout(() => this.loadMixer(), 500);
    });
  },

  async _initAnnouncements() {
    this._announcementsLoaded = true;
    const container = document.getElementById('announce-container');
    if (!container) return;

    try {
      const resp = await fetch('/api/ha/entities?domain=automation&q=alexaannounce', {
        headers: { 'X-Tablet-ID': MacroAPI.tabletId },
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      const entities = data.domains?.automation?.entities || [];
      // Filter to only automation.automation_alexaannounce_* entity IDs
      this._announcements = entities.filter(e =>
        e.entity_id.startsWith('automation.automation_alexaannounce_')
      );
    } catch (e) {
      console.error('Failed to load Alexa announcements:', e);
      this._announcements = [];
    }

    const options = this._announcements.map(a => {
      const label = a.friendly_name || a.entity_id.replace('automation.automation_alexaannounce_', '').replace(/_/g, ' ');
      return `<option value="${a.entity_id}">${label}</option>`;
    }).join('');

    container.innerHTML = `
      <div class="announce-form">
        <label class="announce-label">Select an announcement</label>
        <select id="announce-select" class="routing-select" style="width:100%;margin-bottom:10px;">
          <option value="">-- Choose --</option>
          ${options}
          <option value="__custom__">Custom Announcement</option>
        </select>
        <div id="announce-description" class="announce-description" style="display:none;"></div>
        <textarea id="announce-custom-text" class="announce-textarea" style="display:none;"
          placeholder="Type your announcement message..." rows="3"></textarea>
        <button class="btn" id="btn-announce" style="margin-top:10px;max-width:220px;">
          <span class="material-icons">campaign</span>
          <span class="btn-label">Announce</span>
        </button>
      </div>
    `;

    // Dropdown change handler
    document.getElementById('announce-select')?.addEventListener('change', (e) => {
      const val = e.target.value;
      const descEl = document.getElementById('announce-description');
      const textEl = document.getElementById('announce-custom-text');

      if (val === '__custom__') {
        descEl.style.display = 'none';
        textEl.style.display = '';
        textEl.focus();
      } else if (val) {
        textEl.style.display = 'none';
        const ann = this._announcements.find(a => a.entity_id === val);
        const desc = ann?.attributes?.description;
        if (desc) {
          descEl.textContent = desc;
          descEl.style.display = '';
        } else {
          descEl.style.display = 'none';
        }
      } else {
        descEl.style.display = 'none';
        textEl.style.display = 'none';
      }
    });

    // Announce button
    document.getElementById('btn-announce')?.addEventListener('click', () => this._sendAnnouncement());
  },

  async _sendAnnouncement() {
    const select = document.getElementById('announce-select');
    const textArea = document.getElementById('announce-custom-text');
    const val = select?.value;
    if (!val) {
      App.showToast('Please select an announcement first', 2000);
      return;
    }

    const isCustom = val === '__custom__';
    const customMsg = textArea?.value?.trim();
    if (isCustom && !customMsg) {
      App.showToast('Please type a message first', 2000);
      return;
    }

    const label = isCustom ? `"${customMsg}"` : select.options[select.selectedIndex].text;
    if (!await App.showConfirm(`Broadcast this announcement?\n\n${label}`)) return;

    try {
      let resp;
      if (isCustom) {
        resp = await fetch('/api/ha/service/notify/send_message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': MacroAPI.tabletId },
          body: JSON.stringify({
            entity_id: 'notify.av_room_echo_dot_announce',
            message: customMsg,
          }),
          signal: AbortSignal.timeout(15000),
        });
      } else {
        resp = await fetch('/api/ha/service/automation/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Tablet-ID': MacroAPI.tabletId },
          body: JSON.stringify({ entity_id: val }),
          signal: AbortSignal.timeout(15000),
        });
      }
      if (resp.ok) {
        App.showToast('Announcement sent!', 3000);
        if (isCustom) textArea.value = '';
      } else {
        App.showToast('Announcement failed — check HA logs', 4000);
      }
    } catch (e) {
      console.error('Announcement error:', e);
      App.showToast('Announcement failed — network error', 4000);
    }
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
            <h3>Audio Tab - Input Channels & Bus Outputs</h3>
            <p class="help-note">Shows individual channel faders with volume sliders and mute buttons. Bus/Aux outputs show mute state and volume levels. Only channels with names assigned on the X32 are shown.</p>
          </div>

          <div class="help-section">
            <h3>Announcements Tab</h3>
            <p class="help-note">Broadcasts voice announcements through the church Alexa system.</p>
            <dl class="help-list">
              <dt>Preset Announcements</dt>
              <dd>Select a pre-configured announcement from the dropdown. These are defined as Home Assistant automations and may include specific wording, timing, or multi-step sequences.</dd>
              <dt>Custom Announcement</dt>
              <dd>Choose "Custom Announcement" from the dropdown to type a free-form message. The text will be spoken by Alexa exactly as typed.</dd>
              <dt><span class="material-icons">campaign</span> Announce</dt>
              <dd>Sends the selected or custom announcement. A confirmation dialog will appear before broadcasting.</dd>
            </dl>
          </div>
        </div>
      `;
    });
  },

  destroy() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.mixerTimer) { clearInterval(this.mixerTimer); this.mixerTimer = null; }
    this._announcementsLoaded = false;
    this._announcements = [];
  }
};
