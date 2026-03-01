const ChapelPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>CHAPEL</h1>
          <button class="help-icon-btn" id="chapel-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
        </div>
        <div id="chapel-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('chapel-macro-buttons');
    if (!btnContainer) return;

    document.getElementById('chapel-help-btn')?.addEventListener('click', () => this._showHelp());

    const data = await MacroAPI.getButtons('chapel');
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
    App.showPanel('Chapel - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page controls the Chapel AV system including TVs, audio, climate, and video source routing.</p>
          </div>

          <div class="help-section">
            <h3>System</h3>
            <dl class="help-list">
              <dt><span class="material-icons">play_circle</span> Full Setup</dt>
              <dd>Runs the complete Chapel setup sequence: powers on TVs, audio system, and sets default video source. Shows step-by-step progress.</dd>
              <dt><span class="material-icons">stop_circle</span> Full Teardown</dt>
              <dd>Runs the complete Chapel teardown sequence: powers off all TVs and audio. Shows step-by-step progress.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Video</h3>
            <dl class="help-list">
              <dt><span class="material-icons">tv</span> TVs On</dt>
              <dd>Powers on the Chapel TVs via IR and battery power supplies. The badge shows battery level. TVs may take a moment if batteries need to power up first.</dd>
              <dt><span class="material-icons">tv_off</span> TVs Off</dt>
              <dd>Powers off the Chapel TVs and their battery power supplies.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Audio</h3>
            <dl class="help-list">
              <dt><span class="material-icons">mic</span> Audio On</dt>
              <dd>Powers on the Chapel audio amplifier. The button turns green when the amplifier is on.</dd>
              <dt><span class="material-icons">mic_off</span> Audio Off</dt>
              <dd>Powers off the Chapel audio amplifier.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>A/C</h3>
            <dl class="help-list">
              <dt><span class="material-icons">thermostat</span> Thermostat</dt>
              <dd>Opens the thermostat control dial for the Chapel HVAC. Shows current temperature as a badge.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Video Sources</h3>
            <p class="help-note">These buttons route video inputs to the Chapel TVs. The active source is highlighted in orange.</p>
            <dl class="help-list">
              <dt><span class="material-icons">computer</span> Hall Laptop</dt>
              <dd>Routes the Hall Laptop input to the Chapel TVs.</dd>
              <dt><span class="material-icons">cast</span> Apple TV</dt>
              <dd>Routes the Apple TV to the Chapel TVs.</dd>
              <dt><span class="material-icons">desktop_windows</span> Windows Disp</dt>
              <dd>Routes the Windows Display PC to the Chapel TVs.</dd>
              <dt><span class="material-icons">announcement</span> Announcements</dt>
              <dd>Routes the Announcements PC to the Chapel TVs.</dd>
              <dt><span class="material-icons">cast_connected</span> Google Streamer</dt>
              <dd>Routes the Google Streamer for casting from a phone or laptop.</dd>
              <dt><span class="material-icons">live_tv</span> Live Stream</dt>
              <dd>Routes the live stream camera feed to the Chapel TVs.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Advanced Settings</h3>
            <dl class="help-list">
              <dt>Power Tab</dt>
              <dd>Individual power control for each Chapel device.</dd>
              <dt>TV Controls Tab</dt>
              <dd>IR remote controls for individual TVs (power, HDMI input).</dd>
              <dt>Video Source Tab</dt>
              <dd>Advanced video routing options.</dd>
            </dl>
          </div>
        </div>
      `;
    });
  },

  destroy() {
    if (this._stateHandler) {
      MacroAPI.removeStateListener(this._stateHandler);
      this._stateHandler = null;
    }
  }
};
