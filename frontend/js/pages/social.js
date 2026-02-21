const SocialPage = {
  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>SOCIAL HALL</h1>
      </div>
      <div class="control-section">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">
          <div>
            <div class="section-title">Video</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-social-video-on"><span class="material-icons">tv</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-social-video-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
            </div>
          </div>
          <div>
            <div class="section-title">Audio System</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-social-audio-on"><span class="material-icons">mic</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-social-audio-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
            </div>
          </div>
          <div>
            <div class="section-title">A/C</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-social-ac-on"><span class="material-icons">thermostat</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-social-ac-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
            </div>
          </div>
        </div>
      </div>
      <div class="control-section">
        <div class="section-title">Video Sources</div>
        <div class="control-grid">
          <button class="btn" id="btn-social-appletv"><span class="material-icons">cast</span><span class="btn-label">Apple TV</span></button>
          <button class="btn" id="btn-social-livestream"><span class="material-icons">live_tv</span><span class="btn-label">Live Stream</span></button>
          <button class="btn" id="btn-social-logo"><span class="material-icons">image</span><span class="btn-label">LOGO</span></button>
          <button class="btn" id="btn-social-announcements"><span class="material-icons">announcement</span><span class="btn-label">Announcements</span></button>
          <button class="btn" id="btn-social-camera"><span class="material-icons">videocam</span><span class="btn-label">Camera</span></button>
        </div>
      </div>
    `;
  },
  init() {
    document.getElementById('btn-social-video-on')?.addEventListener('click', () => App.showToast('Social Hall video on'));
    document.getElementById('btn-social-video-off')?.addEventListener('click', () => App.showToast('Social Hall video off'));
    document.getElementById('btn-social-audio-on')?.addEventListener('click', () => App.showToast('Social Hall audio on'));
    document.getElementById('btn-social-audio-off')?.addEventListener('click', () => App.showToast('Social Hall audio off'));
    document.getElementById('btn-social-ac-on')?.addEventListener('click', () => App.showToast('Social Hall A/C on'));
    document.getElementById('btn-social-ac-off')?.addEventListener('click', () => App.showToast('Social Hall A/C off'));
    document.getElementById('btn-social-appletv')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('6', '7');
      await MoIPAPI.switchSource('6', '8');
      App.showToast('Social Hall: Apple TV');
    });
    document.getElementById('btn-social-livestream')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('8', '7');
      await MoIPAPI.switchSource('8', '8');
      App.showToast('Social Hall: Live Stream');
    });
    document.getElementById('btn-social-logo')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('16', '7');
      await MoIPAPI.switchSource('16', '8');
      App.showToast('Social Hall: LOGO');
    });
    document.getElementById('btn-social-announcements')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('9', '7');
      await MoIPAPI.switchSource('9', '8');
      App.showToast('Social Hall: Announcements');
    });
  },
  destroy() {}
};
