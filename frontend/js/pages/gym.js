const GymPage = {
  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>GYM</h1>
      </div>
      <div class="control-section">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
          <div>
            <div class="section-title">Video</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-gym-video-on"><span class="material-icons">tv</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-gym-video-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
            </div>
          </div>
          <div>
            <div class="section-title">Audio</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-gym-audio-on"><span class="material-icons">mic</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-gym-audio-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
            </div>
          </div>
        </div>
      </div>
      <div class="control-section">
        <div class="section-title">Video Sources</div>
        <div class="control-grid">
          <button class="btn" id="btn-gym-livestream"><span class="material-icons">live_tv</span><span class="btn-label">Live Stream</span></button>
          <button class="btn" id="btn-gym-logo"><span class="material-icons">image</span><span class="btn-label">LOGO</span></button>
          <button class="btn" id="btn-gym-announcements"><span class="material-icons">announcement</span><span class="btn-label">Announcements</span></button>
        </div>
      </div>
    `;
  },
  init() {
    document.getElementById('btn-gym-video-on')?.addEventListener('click', () => App.showToast('Gym video on'));
    document.getElementById('btn-gym-video-off')?.addEventListener('click', () => App.showToast('Gym video off'));
    document.getElementById('btn-gym-audio-on')?.addEventListener('click', () => App.showToast('Gym audio on'));
    document.getElementById('btn-gym-audio-off')?.addEventListener('click', () => App.showToast('Gym audio off'));
    document.getElementById('btn-gym-livestream')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('8', '9');
      await MoIPAPI.switchSource('8', '27');
      App.showToast('Gym: Live Stream');
    });
    document.getElementById('btn-gym-logo')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('16', '9');
      await MoIPAPI.switchSource('16', '27');
      App.showToast('Gym: LOGO');
    });
    document.getElementById('btn-gym-announcements')?.addEventListener('click', async () => {
      await MoIPAPI.switchSource('9', '9');
      await MoIPAPI.switchSource('9', '27');
      App.showToast('Gym: Announcements');
    });
  },
  destroy() {}
};
