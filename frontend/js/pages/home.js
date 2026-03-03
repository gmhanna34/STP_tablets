const HomePage = {
  render(container) {
    const displayName = Auth.getDisplayName();
    container.innerHTML = `
      <div class="home-page">
        <h1 class="home-title">Control Panel &ndash; ${displayName}</h1>
        <div class="home-logo-area">
          <img src="assets/images/st-paul-logo.png" alt="St. Paul Logo" class="home-logo"
               onerror="this.style.display='none'">
        </div>
        <div class="home-footer">
          <div class="home-footer-text">To access more settings, click the <strong>SETTINGS</strong> menu item below.</div>
          <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
            <button class="btn" id="btn-open-chat" style="display:inline-flex;">
              <span class="material-icons">support_agent</span>
              <span class="btn-label">AV Help Assistant</span>
            </button>
            <button class="btn home-refresh-btn" id="btn-restart-app">
              <span class="material-icons">refresh</span>
              <span class="btn-label">Restart App</span>
            </button>
          </div>
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
    document.getElementById('btn-open-chat')?.addEventListener('click', () => App.openChat('home'));
  },
  destroy() {}
};
