// Epson Projector API Service - communicates via STP Gateway (server-side proxy)
const EpsonAPI = {
  init() {
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
  },

  async powerOn(projectorKey) {
    try {
      const resp = await fetch(`/api/projector/${projectorKey}/power`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ state: 'on' }),
        signal: AbortSignal.timeout(5000),
      });
      return await resp.json();
    } catch (e) {
      console.error('Epson:', e);
      return null;
    }
  },

  async powerOff(projectorKey) {
    try {
      const resp = await fetch(`/api/projector/${projectorKey}/power`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ state: 'off' }),
        signal: AbortSignal.timeout(5000),
      });
      return await resp.json();
    } catch (e) {
      console.error('Epson:', e);
      return null;
    }
  },

  async allOn() {
    try {
      const resp = await fetch('/api/projector/all/power', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ state: 'on' }),
        signal: AbortSignal.timeout(10000),
      });
      return await resp.json();
    } catch (e) {
      console.error('Epson allOn:', e);
      return null;
    }
  },

  async allOff() {
    try {
      const resp = await fetch('/api/projector/all/power', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ state: 'off' }),
        signal: AbortSignal.timeout(10000),
      });
      return await resp.json();
    } catch (e) {
      console.error('Epson allOff:', e);
      return null;
    }
  },

  async getStatus() {
    try {
      const resp = await fetch('/api/projector/status', {
        headers: { 'X-Tablet-ID': this.tabletId },
        signal: AbortSignal.timeout(5000),
      });
      return await resp.json();
    } catch (e) {
      console.error('Epson status:', e);
      return null;
    }
  }
};
