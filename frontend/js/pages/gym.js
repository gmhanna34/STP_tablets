const GymPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>GYM</h1>
          <button class="help-icon-btn" id="gym-help-btn" title="Page Help">
            <span class="material-icons">help_outline</span>
          </button>
        </div>
        <div id="gym-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('gym-macro-buttons');
    if (!btnContainer) return;

    document.getElementById('gym-help-btn')?.addEventListener('click', () => this._showHelp());

    const data = await MacroAPI.getButtons('gym');
    this._sections = data.buttons || [];
    this._macros = data.macros || {};

    await MacroAPI.fetchState();
    MacroAPI.renderButtons(btnContainer, this._sections, this._macros);

    this._stateHandler = () => {
      MacroAPI.updateButtonStates(btnContainer, this._sections);
    };
    MacroAPI.onStateChange(this._stateHandler);

    this._fetchAndShowScene();
  },

  async _fetchAndShowScene() {
    if (X32API.state.currentSceneName) {
      this._renderScenePill(X32API.state.currentSceneName);
    }
    const info = await X32API.fetchScene();
    if (info?.name) {
      this._renderScenePill(info.name);
    } else if (!X32API.state.currentSceneName) {
      this._renderScenePill('X32 Offline', true);
    }
  },

  _renderScenePill(text, offline) {
    if (!text) return;
    const container = document.getElementById('gym-macro-buttons');
    if (!container) return;
    const titles = container.querySelectorAll('.section-title');
    for (const title of titles) {
      const titleText = title.childNodes[0]?.textContent || '';
      if (/audio/i.test(titleText)) {
        let pill = title.querySelector('.scene-pill');
        if (!pill) {
          pill = document.createElement('span');
          pill.className = 'scene-pill';
          title.appendChild(pill);
        }
        pill.textContent = text;
        pill.classList.toggle('scene-pill-offline', !!offline);
        return;
      }
    }
  },

  updateStatus() {
    if (X32API.state.currentSceneName) {
      this._renderScenePill(X32API.state.currentSceneName);
    } else if (!X32API.state.online) {
      this._renderScenePill('X32 Offline', true);
    }
  },

  _showHelp() {
    App.showPanel('Gym - Help', (body) => {
      body.innerHTML = `
        <div class="help-content">
          <div class="help-intro">
            <p>This page controls the Gym AV system including video display and audio.</p>
          </div>

          <div class="help-section">
            <h3>Video</h3>
            <dl class="help-list">
              <dt><span class="material-icons">tv</span> On</dt>
              <dd>Powers on the Gym TV display.</dd>
              <dt><span class="material-icons">tv_off</span> Off</dt>
              <dd>Powers off the Gym TV display.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Audio</h3>
            <dl class="help-list">
              <dt><span class="material-icons">mic</span> On</dt>
              <dd>Powers on the Gym audio system.</dd>
              <dt><span class="material-icons">mic_off</span> Off</dt>
              <dd>Powers off the Gym audio system.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Video Sources</h3>
            <p class="help-note">These buttons route video inputs to the Gym TV. The active source is highlighted in orange.</p>
            <dl class="help-list">
              <dt><span class="material-icons">live_tv</span> Live Stream</dt>
              <dd>Routes the live stream camera feed to the Gym TV.</dd>
              <dt><span class="material-icons">announcement</span> Announcements</dt>
              <dd>Routes the Announcements PC to the Gym TV.</dd>
            </dl>
          </div>

          <div class="help-section">
            <h3>Advanced Settings</h3>
            <dl class="help-list">
              <dt>Power Tab</dt>
              <dd>Individual power control for Gym devices.</dd>
              <dt>TV Controls Tab</dt>
              <dd>IR remote controls for the Gym TV.</dd>
              <dt>Video Source Tab</dt>
              <dd>Advanced video routing options.</dd>
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
        App.openChat('gym');
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
