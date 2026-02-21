// PTZ Camera API Service - communicates via STP Gateway (server-side proxy)
const PtzAPI = {
  init() {
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
  },

  async sendCommand(cameraKey, command) {
    try {
      const resp = await fetch(`/api/ptz/${cameraKey}/command`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ command }),
        signal: AbortSignal.timeout(3000),
      });
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
        headers: { 'X-Tablet-ID': this.tabletId },
        signal: AbortSignal.timeout(3000),
      });
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
