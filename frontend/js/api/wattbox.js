// WattBox API Service - communicates via STP Gateway (Home Assistant proxy)
const WattBoxAPI = {
  state: { outlets: {} },

  init() {
    this.tabletId = localStorage.getItem('tabletId') || 'WebApp';
  },

  async poll() {
    return this.state;
  },

  async setOutlet(outletId, state) {
    const entityId = `switch.wattbox_outlet_${outletId}`;
    const service = state.toLowerCase() === 'on' ? 'turn_on' : 'turn_off';
    try {
      const resp = await fetch(`/api/ha/service/switch/${service}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tablet-ID': this.tabletId,
        },
        body: JSON.stringify({ entity_id: entityId }),
        signal: AbortSignal.timeout(5000),
      });
      return await resp.json();
    } catch (e) {
      console.error('WattBox setOutlet:', e);
      return null;
    }
  }
};
