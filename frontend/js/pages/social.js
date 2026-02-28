const SocialPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>SOCIAL HALL</h1>
        </div>
        <div id="social-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
        <a class="section-link" href="#" id="social-power-link">
          <span class="material-icons">chevron_right</span>
          <span>Advanced Power Settings</span>
        </a>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('social-macro-buttons');
    if (!btnContainer) return;

    const data = await MacroAPI.getButtons('social');
    this._sections = data.buttons || [];
    this._macros = data.macros || {};

    await MacroAPI.fetchState();
    MacroAPI.renderButtons(btnContainer, this._sections, this._macros);

    this._stateHandler = () => {
      MacroAPI.updateButtonStates(btnContainer, this._sections);
    };
    MacroAPI.onStateChange(this._stateHandler);

    // Wire Advanced Power Settings link
    const powerLink = document.getElementById('social-power-link');
    if (powerLink) {
      powerLink.addEventListener('click', (e) => {
        e.preventDefault();
        MacroAPI.openPowerPanel('social');
      });
    }
  },

  destroy() {
    if (this._stateHandler) {
      MacroAPI.removeStateListener(this._stateHandler);
      this._stateHandler = null;
    }
  }
};
