const ConfRoomPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>CONFERENCE ROOM</h1>
        </div>
        <div id="confroom-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
        <a class="section-link" href="#" id="confroom-power-link">
          <span class="material-icons">chevron_right</span>
          <span>Advanced Power Settings</span>
        </a>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('confroom-macro-buttons');
    if (!btnContainer) return;

    const data = await MacroAPI.getButtons('confroom');
    this._sections = data.buttons || [];
    this._macros = data.macros || {};

    await MacroAPI.fetchState();
    MacroAPI.renderButtons(btnContainer, this._sections, this._macros);

    this._stateHandler = () => {
      MacroAPI.updateButtonStates(btnContainer, this._sections);
    };
    MacroAPI.onStateChange(this._stateHandler);

    // Wire Advanced Power Settings link
    const powerLink = document.getElementById('confroom-power-link');
    if (powerLink) {
      powerLink.addEventListener('click', (e) => {
        e.preventDefault();
        MacroAPI.openPowerPanel('confroom');
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
