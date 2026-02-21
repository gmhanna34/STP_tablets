const MainPage = {
  pollTimer: null,

  render(container) {
    container.innerHTML = `
      <div class="page-header">
        <h1>MAIN CHURCH</h1>
      </div>

      <div class="control-section">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;">
          <div>
            <div class="section-title">Video</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-video-on"><span class="material-icons">tv</span><span class="btn-label">On / Down</span></button>
              <button class="btn btn-large" id="btn-video-off"><span class="material-icons">close</span><span class="btn-label">Off / Up</span></button>
              <button class="btn" id="btn-proj-only-on"><span class="btn-label">Projectors Only On</span></button>
              <button class="btn" id="btn-proj-only-off"><span class="btn-label">Projectors Only Off</span></button>
              <button class="btn" id="btn-port-only-on"><span class="btn-label">Portables Only On</span></button>
              <button class="btn" id="btn-port-only-off"><span class="btn-label">Portables Only Off</span></button>
            </div>
          </div>
          <div>
            <div class="section-title">Audio System</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-audio-on"><span class="material-icons">mic</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-audio-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
              <button class="btn" id="btn-appletv-restart"><span class="btn-label">AppleTV Restart</span></button>
            </div>
          </div>
          <div>
            <div class="section-title">A/C</div>
            <div class="control-grid" style="grid-template-columns:1fr;">
              <button class="btn btn-large" id="btn-ac-on"><span class="material-icons">thermostat</span><span class="btn-label">On</span></button>
              <button class="btn btn-large" id="btn-ac-off"><span class="material-icons">close</span><span class="btn-label">Off</span></button>
            </div>
            <div class="thermostat-display mt-16" id="thermostat-display">
              <span class="temp-value" id="main-temp">--°</span>
              <span class="temp-mode" id="main-temp-mode">--</span>
            </div>
          </div>
        </div>
      </div>

      <div class="control-section">
        <div class="section-title">Video Sources</div>
        <div class="control-grid">
          <button class="btn" data-source="MainChurch_LeftPodium"><span class="material-icons">computer</span><span class="btn-label">Left Podium</span></button>
          <button class="btn" data-source="MainChurch_RightPodium"><span class="material-icons">computer</span><span class="btn-label">Right Podium</span></button>
          <button class="btn" data-source="MainChurch_Announcements"><span class="material-icons">announcement</span><span class="btn-label">Announcements</span></button>
          <button class="btn" data-source="MainChurch_LOGO"><span class="material-icons">image</span><span class="btn-label">LOGO</span></button>
          <button class="btn" data-source="MainChurch_LiveStream"><span class="material-icons">live_tv</span><span class="btn-label">Live Stream</span></button>
          <button class="btn" data-source="MainChurch_AppleTV"><span class="material-icons">cast</span><span class="btn-label">Apple TV</span></button>
          <button class="btn" data-source="MainChurch_GoogleStreamer"><span class="material-icons">cast_connected</span><span class="btn-label">Google Streamer</span></button>
        </div>
      </div>

      <div class="text-center mt-16">
        <button class="btn" id="btn-show-advanced" style="display:inline-flex;max-width:400px;">
          <span class="material-icons">tune</span>
          <span class="btn-label">For Advanced Display Settings, click here</span>
        </button>
        <button class="btn" id="btn-show-power" style="display:inline-flex;max-width:400px;">
          <span class="material-icons">power_settings_new</span>
          <span class="btn-label">For Advanced Power Settings, click here</span>
        </button>
        <button class="btn" id="btn-show-baptism" style="display:inline-flex;max-width:400px;">
          <span class="material-icons">water_drop</span>
          <span class="btn-label">For Baptism/Wedding Settings, click here</span>
        </button>
      </div>

      <div class="control-section hidden" id="advanced-display">
        <div class="section-title">Advanced Display Settings</div>
        <button class="btn" id="btn-close-advanced" style="float:right;width:auto;padding:8px;"><span class="material-icons">close</span></button>
        <div class="control-grid" style="clear:both;">
          <button class="btn" data-projector="epson1" data-action="on"><span class="btn-label">PRJ Front Left ON</span></button>
          <button class="btn" data-projector="epson1" data-action="off"><span class="btn-label">PRJ Front Left OFF</span></button>
          <button class="btn" data-projector="epson2" data-action="on"><span class="btn-label">PRJ Front Right ON</span></button>
          <button class="btn" data-projector="epson2" data-action="off"><span class="btn-label">PRJ Front Right OFF</span></button>
          <button class="btn" data-projector="epson3" data-action="on"><span class="btn-label">PRJ Rear Left ON</span></button>
          <button class="btn" data-projector="epson3" data-action="off"><span class="btn-label">PRJ Rear Left OFF</span></button>
          <button class="btn" data-projector="epson4" data-action="on"><span class="btn-label">PRJ Rear Right ON</span></button>
          <button class="btn" data-projector="epson4" data-action="off"><span class="btn-label">PRJ Rear Right OFF</span></button>
        </div>
      </div>

      <div class="control-section hidden" id="advanced-power">
        <div class="section-title">Advanced Power Settings</div>
        <button class="btn" id="btn-close-power" style="float:right;width:auto;padding:8px;"><span class="material-icons">close</span></button>
        <div class="control-grid" style="clear:both;">
          <button class="btn" id="btn-wattbox1-on"><span class="btn-label">WattBox 1 ON</span></button>
          <button class="btn" id="btn-wattbox1-off"><span class="btn-label">WattBox 1 OFF</span></button>
          <button class="btn" id="btn-wattbox2-on"><span class="btn-label">WattBox 2 ON</span></button>
          <button class="btn" id="btn-wattbox2-off"><span class="btn-label">WattBox 2 OFF</span></button>
        </div>
      </div>

      <div class="control-section hidden" id="baptism-section">
        <div class="section-title">Baptism / Wedding Settings</div>
        <button class="btn" id="btn-close-baptism" style="float:right;width:auto;padding:8px;"><span class="material-icons">close</span></button>
        <div class="control-grid" style="clear:both;">
          <button class="btn" id="btn-baptism-cam"><span class="material-icons">videocam</span><span class="btn-label">Baptism Camera View</span></button>
        </div>
      </div>
    `;
  },

  init() {
    // Video controls
    document.getElementById('btn-video-on')?.addEventListener('click', async () => {
      await EpsonAPI.allOn();
      // Screens down and cry room on handled via scenes/middleware
      App.showToast('Video system turning on...');
    });
    document.getElementById('btn-video-off')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Turn OFF the entire video system (all projectors + screens)?')) return;
      await EpsonAPI.allOff();
      App.showToast('Video system turning off...');
    });
    document.getElementById('btn-proj-only-on')?.addEventListener('click', async () => {
      await EpsonAPI.allOn();
      App.showToast('Projectors turning on...');
    });
    document.getElementById('btn-proj-only-off')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Turn OFF all projectors?')) return;
      await EpsonAPI.allOff();
      App.showToast('Projectors turning off...');
    });

    // Audio controls
    document.getElementById('btn-audio-on')?.addEventListener('click', async () => {
      await WattBoxAPI.setOutlet(1, 'On');
      await WattBoxAPI.setOutlet(2, 'On');
      App.showToast('Audio system turning on...');
    });
    document.getElementById('btn-audio-off')?.addEventListener('click', async () => {
      if (!await App.showConfirm('Turn OFF the audio system?')) return;
      await WattBoxAPI.setOutlet(1, 'Off');
      await WattBoxAPI.setOutlet(2, 'Off');
      App.showToast('Audio system turning off...');
    });

    // AppleTV restart
    document.getElementById('btn-appletv-restart')?.addEventListener('click', () => {
      App.showToast('Restarting AppleTV...');
    });

    // Video source buttons — uses server-side scene engine for retry + progress
    document.querySelectorAll('[data-source]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sceneKey = btn.dataset.source;
        const devicesConfig = App.devicesConfig;
        const sceneLabel = devicesConfig?.moip?.scenes?.[sceneKey]?.label || sceneKey;

        btn.disabled = true;
        btn.classList.add('loading');
        App.showToast(`Switching to ${sceneLabel}...`);

        const result = await MoIPAPI.executeScene(sceneKey);

        btn.disabled = false;
        btn.classList.remove('loading');

        if (result && result.success) {
          App.showToast(`Source: ${sceneLabel}`);
        } else if (result && result.error) {
          App.showToast(`Failed: ${result.error}`);
        } else {
          App.showToast('Scene switch failed — check connection');
        }
      });
    });

    // Individual projector controls
    document.querySelectorAll('[data-projector]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const proj = btn.dataset.projector;
        const action = btn.dataset.action;
        if (action === 'on') await EpsonAPI.powerOn(proj);
        else await EpsonAPI.powerOff(proj);
        App.showToast(`${proj} ${action}`);
      });
    });

    // Toggle sections
    document.getElementById('btn-show-advanced')?.addEventListener('click', () => {
      document.getElementById('advanced-display')?.classList.remove('hidden');
    });
    document.getElementById('btn-close-advanced')?.addEventListener('click', () => {
      document.getElementById('advanced-display')?.classList.add('hidden');
    });
    document.getElementById('btn-show-power')?.addEventListener('click', () => {
      document.getElementById('advanced-power')?.classList.remove('hidden');
    });
    document.getElementById('btn-close-power')?.addEventListener('click', () => {
      document.getElementById('advanced-power')?.classList.add('hidden');
    });
    document.getElementById('btn-show-baptism')?.addEventListener('click', () => {
      document.getElementById('baptism-section')?.classList.remove('hidden');
    });
    document.getElementById('btn-close-baptism')?.addEventListener('click', () => {
      document.getElementById('baptism-section')?.classList.add('hidden');
    });

    // WattBox
    document.getElementById('btn-wattbox1-on')?.addEventListener('click', () => WattBoxAPI.setOutlet(1, 'On'));
    document.getElementById('btn-wattbox1-off')?.addEventListener('click', () => WattBoxAPI.setOutlet(1, 'Off'));
    document.getElementById('btn-wattbox2-on')?.addEventListener('click', () => WattBoxAPI.setOutlet(2, 'On'));
    document.getElementById('btn-wattbox2-off')?.addEventListener('click', () => WattBoxAPI.setOutlet(2, 'Off'));
  },

  destroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
};
