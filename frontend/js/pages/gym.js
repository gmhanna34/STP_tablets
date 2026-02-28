const GymPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>GYM</h1>
        </div>
        <div id="gym-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
        <a class="section-link" href="#" id="gym-power-link">
          <span class="material-icons">chevron_right</span>
          <span>Advanced Power Settings</span>
        </a>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('gym-macro-buttons');
    if (!btnContainer) return;

    const data = await MacroAPI.getButtons('gym');
    this._sections = data.buttons || [];
    this._macros = data.macros || {};

    await MacroAPI.fetchState();
    MacroAPI.renderButtons(btnContainer, this._sections, this._macros);

    this._stateHandler = () => {
      MacroAPI.updateButtonStates(btnContainer, this._sections);
    };
    MacroAPI.onStateChange(this._stateHandler);

    // Wire Advanced Power Settings link
    const powerLink = document.getElementById('gym-power-link');
    if (powerLink) {
      powerLink.addEventListener('click', (e) => {
        e.preventDefault();
        MacroAPI.openPowerPanel('gym');
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
