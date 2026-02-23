// MoIP API Service - communicates via STP Gateway
const MoIPAPI = {
  state: { receivers: {} },

  init() {
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
  },

  async sendCommand(endpoint, method = 'GET', data = null) {
    const url = `/api/moip${endpoint}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Tablet-ID': this.tabletId,
      },
      signal: AbortSignal.timeout(5000),
    };
    if (data && method !== 'GET') options.body = JSON.stringify(data);

    try {
      const resp = await fetch(url, options);
      return await resp.json();
    } catch (e) {
      console.error('MoIP:', e);
      return null;
    }
  },

  async poll() {
    const data = await this.sendCommand('/receivers');
    if (data && !data.error) this.state.receivers = data;
    return this.state;
  },

  async switchSource(transmitterId, receiverId) {
    return await this.sendCommand('/switch', 'POST', { transmitter: transmitterId, receiver: receiverId });
  },

  async sendIR(tx, rx, codeKey) {
    return await this.sendCommand('/ir', 'POST', { tx: String(tx), rx: String(rx), code: codeKey });
  },

  async sendOSD(text) {
    return await this.sendCommand('/osd', 'POST', { text });
  },

  async clearOSD() {
    return await this.sendCommand('/osd', 'POST', { clear: true });
  },

  // Called by Socket.IO state push
  onStateUpdate(data) {
    if (data) this.state.receivers = data;
  }
};
