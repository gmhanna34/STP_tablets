// Health API Service - communicates via STP Gateway
const HealthAPI = {
  state: {
    downCount: 0,
    warningCount: 0,
    healthyCount: 0,
    totalCount: 0,
    lastGenerated: '',
    details: []
  },

  init(config) {
    this.healthCheckUrl = config?.healthCheck?.url || '';
  },

  async poll() {
    try {
      // Health dashboard is still accessed directly (it's a separate service)
      const url = this.healthCheckUrl
        ? `http://${this.healthCheckUrl}/api/status`
        : '/api/health';
      const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const data = await resp.json();
      if (data) {
        this.state.downCount = data.downCount || 0;
        this.state.warningCount = data.warningCount || 0;
        this.state.healthyCount = data.healthyCount || 0;
        this.state.totalCount = data.totalCount || 0;
        this.state.lastGenerated = data.lastGenerated || '';
        this.state.details = data.details || [];
      }
    } catch (e) {
      // Health check unavailable
    }
    return this.state;
  },

  getStatusUrl() {
    return this.healthCheckUrl ? `http://${this.healthCheckUrl}` : '/api/health';
  }
};
