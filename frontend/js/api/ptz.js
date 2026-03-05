// PTZ Camera API Service - communicates via STP Gateway (server-side proxy)
const PtzAPI = {
  init() {
  },

  async sendCommand(cameraKey, command) {
    try {
      const resp = await fetch(`/api/ptz/${cameraKey}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error('PTZ:', e);
      return null;
    }
  },

  async callPreset(cameraKey, presetNum) {
    try {
      const resp = await fetch(`/api/ptz/${cameraKey}/preset/${presetNum}`, {
        method: 'POST',
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error('PTZ preset:', e);
      return null;
    }
  },

  async setPreset(cameraKey, presetNum) {
    return await this.sendCommand(cameraKey, `posset&${presetNum}`);
  },

  async panTilt(cameraKey, direction, speed = 5) {
    return await this.sendCommand(cameraKey, `${direction}&${speed}&${speed}`);
  },

  async zoomIn(cameraKey, speed = 5) { return await this.sendCommand(cameraKey, `zoomin&${speed}`); },
  async zoomOut(cameraKey, speed = 5) { return await this.sendCommand(cameraKey, `zoomout&${speed}`); },
  async zoomStop(cameraKey) { return await this.sendCommand(cameraKey, `zoomstop`); },
  async home(cameraKey) { return await this.sendCommand(cameraKey, `home`); }
};
