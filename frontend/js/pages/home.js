const HomePage = {
  render(container) {
    const displayName = Auth.getDisplayName();
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>Control Panel - ${displayName}</h1>
        </div>
        <div class="info-text" style="margin:10px auto;">
          <p>All menu items below should be active.</p>
          <p>To access more settings, click the SETTINGS menu item below.</p>
        </div>
        <div class="text-center">
          <button class="btn" id="btn-restart-app" style="display:inline-flex;max-width:400px;">
            <span class="material-icons">refresh</span>
            <span class="btn-label">If you are having issues and need to restart the app, click here.</span>
          </button>
        </div>
        <div id="health-summary" class="text-center" style="display:none;">
          <div class="control-section">
            <div class="section-title">System Health</div>
            <div id="health-details"></div>
          </div>
        </div>
      </div>
    `;
  },
  init() {
    document.getElementById('btn-restart-app')?.addEventListener('click', () => {
      // Use Fully Kiosk loadStartUrl to preserve the tablet's configured URL path
      new Image().src = `http://127.0.0.1:2323/?password=admin&cmd=loadStartUrl&_t=${Date.now()}`;
    });
  },
  destroy() {}
};
