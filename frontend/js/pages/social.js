const SocialPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>SOCIAL HALL</h1>
          <button class="help-icon-btn" id="social-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
        </div>
        <div id="social-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('social-macro-buttons');
    if (!btnContainer) return;

    document.getElementById('social-help-btn')?.addEventListener('click', () => this._showHelp());

    const data = await MacroAPI.getButtons('social');
    this._sections = data.buttons || [];
    this._macros = data.macros || {};

    await MacroAPI.fetchState();
    MacroAPI.renderButtons(btnContainer, this._sections, this._macros);

    this._stateHandler = () => {
      MacroAPI.updateButtonStates(btnContainer, this._sections);
    };
    MacroAPI.onStateChange(this._stateHandler);
  },

  _showHelp() {
    App.showPanel('Social Hall - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page controls the Social Hall AV system including 8 display panels, audio, climate, and video source routing.</p>
          </div>

          <div class="help-section">
            <h3>Video</h3>
            <dl class="help-list">
              <dt><span class="material-icons">tv</span> On</dt>
              <dd>Powers on all 8 Social Hall display panels and routes the default video source.</dd>
              <dt><span class="material-icons">tv_off</span> Off</dt>
              <dd>Powers off all 8 Social Hall display panels.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Audio System</h3>
            <dl class="help-list">
              <dt><span class="material-icons">mic</span> On</dt>
              <dd>Powers on the Social Hall audio system including amplifiers and microphone receivers.</dd>
              <dt><span class="material-icons">mic_off</span> Off</dt>
              <dd>Powers off the Social Hall audio system.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>A/C</h3>
            <dl class="help-list">
              <dt><span class="material-icons">thermostat</span> Thermostat</dt>
              <dd>Opens the thermostat control dial for the Social Hall HVAC. Shows current temperature as a badge.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Video Sources</h3>
            <p class="help-note">These buttons route video inputs to all Social Hall displays. The active source is highlighted in orange.</p>
            <dl class="help-list">
              <dt><span class="material-icons">cast</span> Apple TV</dt>
              <dd>Routes the Social Hall Apple TV to all displays.</dd>
              <dt><span class="material-icons">live_tv</span> Live Stream</dt>
              <dd>Routes the live stream camera feed to all displays.</dd>
              <dt><span class="material-icons">announcement</span> Announcements</dt>
              <dd>Routes the Announcements PC to all displays.</dd>
              <dt><span class="material-icons">videocam</span> Camera</dt>
              <dd>Routes the camera feed directly to all displays.</dd>
              <dt><span class="material-icons">computer</span> Laptop</dt>
              <dd>Routes the laptop input to all displays.</dd>
              <dt><span class="material-icons">desktop_windows</span> Windows Display</dt>
              <dd>Routes the Windows Display PC to all displays.</dd>
              <dt><span class="material-icons">cast_connected</span> Google Streamer</dt>
              <dd>Routes the Google Streamer for casting from a phone or laptop.</dd>
              <dt><span class="material-icons">child_care</span> VBS</dt>
              <dd>Routes the VBS (Vacation Bible School) content to all displays. Uses the same source as Laptop.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Advanced Settings</h3>
            <dl class="help-list">
              <dt>Power Tab</dt>
              <dd>Individual power control for each Social Hall device.</dd>
              <dt>TV Controls Tab</dt>
              <dd>IR remote controls for individual TVs and AppleTV restart.</dd>
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
        App.openChat('social');
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
