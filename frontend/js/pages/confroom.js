const ConfRoomPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>CONFERENCE ROOM</h1>
          <button class="help-icon-btn" id="confroom-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
        </div>
        <div id="confroom-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('confroom-macro-buttons');
    if (!btnContainer) return;

    document.getElementById('confroom-help-btn')?.addEventListener('click', () => this._showHelp());

    const data = await MacroAPI.getButtons('confroom');
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
    App.showPanel('Conference Room - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page controls the Conference Room including two TVs, video conferencing, climate, and independent video source routing for each TV.</p>
          </div>

          <div class="help-section">
            <h3>Left TV / Right TV</h3>
            <dl class="help-list">
              <dt><span class="material-icons">tv</span> On</dt>
              <dd>Powers on the left or right TV individually.</dd>
              <dt><span class="material-icons">tv_off</span> Off</dt>
              <dd>Powers off the left or right TV individually.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Video Conference</h3>
            <dl class="help-list">
              <dt><span class="material-icons">video_call</span> On</dt>
              <dd>Powers on the video conference system (camera, mic, display).</dd>
              <dt><span class="material-icons">videocam_off</span> Off</dt>
              <dd>Powers off the video conference system.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>A/C</h3>
            <dl class="help-list">
              <dt><span class="material-icons">thermostat</span> Thermostat</dt>
              <dd>Opens the thermostat control dial for the Conference Room HVAC. Shows current temperature as a badge.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Left TV Sources / Right TV Sources</h3>
            <p class="help-note">Each TV has independent source routing. The active source is highlighted in orange. Both TVs can show different content.</p>
            <dl class="help-list">
              <dt><span class="material-icons">computer</span> Laptop</dt>
              <dd>Routes the conference room laptop to the TV.</dd>
              <dt><span class="material-icons">live_tv</span> Live Stream</dt>
              <dd>Routes the live stream camera feed.</dd>
              <dt><span class="material-icons">announcement</span> Announcements</dt>
              <dd>Routes the Announcements PC.</dd>
              <dt><span class="material-icons">slideshow</span> Slides</dt>
              <dd>Routes the slides/presentation feed.</dd>
              <dt><span class="material-icons">desktop_windows</span> Windows Display</dt>
              <dd>Routes the Windows Display PC.</dd>
              <dt><span class="material-icons">cast</span> Apple TV</dt>
              <dd>Switches TV to HDMI 2 for the directly connected Apple TV (not on MoIP).</dd>
              <dt><span class="material-icons">cast_connected</span> Google Streamer</dt>
              <dd>Routes the Google Streamer for casting from a phone or laptop.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Advanced Settings</h3>
            <dl class="help-list">
              <dt>Power Tab</dt>
              <dd>Individual power control for Conference Room devices.</dd>
              <dt>TV Controls Tab</dt>
              <dd>IR remote controls for each TV and AppleTV restart.</dd>
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
