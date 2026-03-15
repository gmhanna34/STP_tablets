const MainPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>MAIN CHURCH</h1>
          <button class="help-icon-btn" id="main-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
        </div>
        <div id="main-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('main-macro-buttons');
    if (!btnContainer) return;

    // Help button
    document.getElementById('main-help-btn')?.addEventListener('click', () => this._showHelp());

    // Fetch button layout + macro definitions from gateway
    const data = await MacroAPI.getButtons('main');
    this._sections = data.buttons || [];
    this._macros = data.macros || {};

    // Fetch current state for state-bound buttons
    await MacroAPI.fetchState();

    // Render the buttons
    MacroAPI.renderButtons(btnContainer, this._sections, this._macros);

    // Listen for state changes to update button indicators
    this._stateHandler = () => {
      MacroAPI.updateButtonStates(btnContainer, this._sections);
    };
    MacroAPI.onStateChange(this._stateHandler);

    // Fetch and display current mixer scene next to Audio section
    this._fetchAndShowScene();
  },

  async _fetchAndShowScene() {
    // Show cached value immediately if available
    if (X32API.state.currentSceneName) {
      this._renderScenePill(X32API.state.currentSceneName);
    }
    // Fetch latest from lightweight health endpoint
    const info = await X32API.fetchScene();
    if (info?.name) this._renderScenePill(info.name);
  },

  _renderScenePill(sceneName) {
    if (!sceneName) return;
    const container = document.getElementById('main-macro-buttons');
    if (!container) return;
    const titles = container.querySelectorAll('.section-title');
    for (const title of titles) {
      // Check original text only (not pill text)
      const titleText = title.childNodes[0]?.textContent || '';
      if (/audio/i.test(titleText)) {
        let pill = title.querySelector('.scene-pill');
        if (!pill) {
          pill = document.createElement('span');
          pill.className = 'scene-pill';
          title.appendChild(pill);
        }
        pill.textContent = sceneName;
        return;
      }
    }
  },

  updateStatus() {
    if (X32API.state.currentSceneName) {
      this._renderScenePill(X32API.state.currentSceneName);
    }
  },

  _showHelp() {
    App.showPanel('Main Church - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page controls the Main Church AV system including video displays, audio, climate, and video source routing.</p>
          </div>

          <div class="help-section">
            <h3>Video</h3>
            <dl class="help-list">
              <dt><span class="material-icons">tv</span> On / Down</dt>
              <dd>Powers on all projectors, lowers the motorized screens, and powers on the portable TVs. This takes about 60 seconds to complete.</dd>
              <dt><span class="material-icons">tv_off</span> Off / Up</dt>
              <dd>Powers off all projectors, raises the motorized screens, and powers off the portable TVs.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Audio System</h3>
            <dl class="help-list">
              <dt><span class="material-icons">mic</span> On</dt>
              <dd>Powers on the audio system including the X32 mixer, amplifiers, and wireless microphone receivers. The button turns green when the system is on.</dd>
              <dt><span class="material-icons">mic_off</span> Off</dt>
              <dd>Powers off the entire audio system.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>A/C</h3>
            <dl class="help-list">
              <dt><span class="material-icons">thermostat</span> Thermostat</dt>
              <dd>Opens the thermostat control dial for the Main Church HVAC. Shows the current temperature as a badge. Tap to adjust the set point, fan mode, or turn the system on/off.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Video Sources</h3>
            <p class="help-note">These buttons route video inputs to the Main Church projectors and displays. The active source is highlighted in orange.</p>
            <dl class="help-list">
              <dt><span class="material-icons">computer</span> Left Podium / Right Podium</dt>
              <dd>Routes the left or right podium laptop (HDMI connections at each podium) to all displays.</dd>
              <dt><span class="material-icons">announcement</span> Announcements</dt>
              <dd>Routes the Announcements PC to all displays for pre-service slides and announcements.</dd>
              <dt><span class="material-icons">live_tv</span> Live Stream</dt>
              <dd>Routes the live stream camera output to all displays, useful for overflow viewing.</dd>
              <dt><span class="material-icons">cast</span> Apple TV (No Page #s / Page #s)</dt>
              <dd>Routes the Apple TV to all displays. "No Page #s" uses a clean feed; "Page #s" uses the feed with hymnal page numbers overlaid.</dd>
              <dt><span class="material-icons">cast_connected</span> Google Streamer</dt>
              <dd>Routes the Google Streamer to all displays for casting content from a phone or laptop.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>People Counts</h3>
            <dl class="help-list">
              <dt><span class="material-icons">groups</span> Occupancy</dt>
              <dd>Shows the current estimated occupancy of the Main Church. Tap to open the detailed analytics panel.</dd>
              <dt><span class="material-icons">how_to_reg</span> Communion</dt>
              <dd>Shows the communion count. Tap to open the detailed analytics panel.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Advanced Settings</h3>
            <p class="help-note">A link at the bottom opens a panel with additional controls:</p>
            <dl class="help-list">
              <dt>Power Tab</dt>
              <dd>Individual power control for each device (projectors, TVs, screens, audio components).</dd>
              <dt>TV Controls Tab</dt>
              <dd>IR remote controls for individual TVs and projectors (power, HDMI input). Also includes projector-only and portable-only on/off controls, and AppleTV restart.</dd>
              <dt>Video Source Tab</dt>
              <dd>Advanced video routing options for individual displays.</dd>
            </dl>
          </div>

          <div class="help-section" style="border-bottom:none;text-align:center;padding-top:16px;">
            <button class="btn" id="help-ask-chat" style="display:inline-flex;max-width:320px;">
              <span class="material-icons">support_agent</span>
              <span class="btn-label">Ask a Question</span>
            </button>
          </div>
        </div>
      `;
      body.querySelector('#help-ask-chat')?.addEventListener('click', () => {
        App.closePanel();
        App.openChat('main');
      });
    });
  },

  destroy() {
    if (this._stateHandler) {
      MacroAPI.removeStateListener(this._stateHandler);
      this._stateHandler = null;
    }
  }
};
