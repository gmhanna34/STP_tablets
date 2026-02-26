// Health API Service - communicates via STP Gateway proxy
const HealthAPI = {
  state: {
    downCount: 0,
    warningCount: 0,
    healthyCount: 0,
    totalCount: 0,
    lastGenerated: '',
  },

  init(config) {
    // External URL is used only for the iframe popup panel
    this.healthCheckUrl = config?.healthCheck?.url || '';
  },

  async poll() {
    try {
      // Fetch via gateway proxy to avoid CORS issues
      const resp = await fetch('/api/healthdash/summary', { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      if (data && data.counts) {
        this.state.downCount = data.counts.down || 0;
        this.state.warningCount = data.counts.warning || 0;
        this.state.healthyCount = data.counts.healthy || 0;
        this.state.totalCount = data.total || 0;
        this.state.lastGenerated = data.generated_at || '';
      }
    } catch (e) {
      // Health dashboard unavailable — keep last known values
    }
    return this.state;
  },

  getStatusUrl() {
    // External URL for the iframe panel
    return this.healthCheckUrl ? `http://${this.healthCheckUrl}` : '';
  }
};
