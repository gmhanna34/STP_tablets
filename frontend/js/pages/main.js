const MainPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>MAIN CHURCH</h1>
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
  },

  destroy() {
    if (this._stateHandler) {
      MacroAPI.removeStateListener(this._stateHandler);
      this._stateHandler = null;
    }
  }
};
