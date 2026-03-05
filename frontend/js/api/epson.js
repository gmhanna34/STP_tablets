// Epson Projector API Service - communicates via STP Gateway (server-side proxy)
const EpsonAPI = {
  init() {
  },

  async powerOn(projectorKey) {
    try {
      const resp = await fetch(`/api/projector/${projectorKey}/power`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ state: 'on' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
        },
        body: JSON.stringify({ state: 'off' }),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
        },
        body: JSON.stringify({ state: 'on' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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
        },
        body: JSON.stringify({ state: 'off' }),
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error('Epson allOff:', e);
      return null;
    }
  },

  async getStatus() {
    try {
      const resp = await fetch('/api/projector/status', {
        headers: {},
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      console.error('Epson status:', e);
      return null;
    }
  }
};
