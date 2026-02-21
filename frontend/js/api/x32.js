// X32 API Service - communicates via STP Gateway
const X32API = {
  state: {
    online: false,
    currentScene: '',
    currentSceneName: '',
    channels: [],
    auxChannels: [],
    scenes: []
  },

  init() {
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
  },

  async sendCommand(endpoint) {
    const url = `/api/x32/${endpoint}`;
    const options = {
      headers: { 'X-Tablet-ID': this.tabletId },
      signal: AbortSignal.timeout(5000),
    };

    try {
      const resp = await fetch(url, options);
      return await resp.json();
    } catch (e) {
      console.error('X32:', e);
      return null;
    }
  },

  async poll() {
    let raw = await this.sendCommand('status');
    if (raw && raw.healthy === true && raw.data) raw = raw.data;
    else if (raw && raw.healthy === false) { this.state.online = false; return this.state; }
    if (!raw || raw.error) { this.state.online = false; return this.state; }

    this._parseSnapshot(raw);
    return this.state;
  },

  _parseSnapshot(raw) {
    this.state.online = true;
    this.state.currentScene = raw.cur_scene || '';
    this.state.currentSceneName = raw.cur_scene_name || '';

    this.state.channels = [];
    for (let i = 1; i <= 32; i++) {
      this.state.channels.push({
        id: i,
        name: raw[`ch${i}name`] || `Ch ${i}`,
        muted: raw[`ch${i}mutestatus`] || '',
        volume: raw[`ch${i}vol`] !== undefined ? parseFloat(raw[`ch${i}vol`]) : 0
      });
    }

    this.state.auxChannels = [];
    for (let a = 1; a <= 8; a++) {
      this.state.auxChannels.push({
        id: a,
        name: raw[`aux${a}_name`] || `Aux ${a}`,
        muted: raw[`aux${a}_mutestatus`] || '',
        volume: raw[`aux${a}vol`] !== undefined ? parseFloat(raw[`aux${a}vol`]) : 0
      });
    }

    this.state.scenes = [];
    for (let s = 0; s <= 25; s++) {
      this.state.scenes.push({ id: s, name: raw[`scene${s}name`] || '' });
    }
  },

  async muteChannel(ch) { await this.sendCommand(`mute/${ch}/on`); },
  async unmuteChannel(ch) { await this.sendCommand(`mute/${ch}/off`); },
  async volumeUp(ch) { await this.sendCommand(`volume/${ch}/up`); },
  async volumeDown(ch) { await this.sendCommand(`volume/${ch}/down`); },
  async loadScene(sceneId) { await this.sendCommand(`scene/${sceneId}`); },
  async muteAux(aux) { await this.sendCommand(`aux/${aux}/mute/on`); },
  async unmuteAux(aux) { await this.sendCommand(`aux/${aux}/mute/off`); },

  // Called by Socket.IO state push
  onStateUpdate(data) {
    if (data && data.data) this._parseSnapshot(data.data);
    else if (data && data.healthy !== undefined) {
      if (data.healthy && data.data) this._parseSnapshot(data.data);
      else this.state.online = false;
    }
  }
};
