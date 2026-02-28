const ChapelPage = {
  _sections: null,
  _macros: null,
  _stateHandler: null,

  render(container) {
    container.innerHTML = `
      <div class="page-grid">
        <div class="page-header">
          <h1>CHAPEL</h1>
        </div>
        <div id="chapel-macro-buttons">
          <div class="text-center" style="opacity:0.5;">Loading controls...</div>
        </div>
        <a class="section-link" href="#" id="chapel-power-link">
          <span class="material-icons">chevron_right</span>
          <span>Advanced Power Settings</span>
        </a>
      </div>
    `;
  },

  async init() {
    const btnContainer = document.getElementById('chapel-macro-buttons');
    if (!btnContainer) return;

    // Fetch button layout + macro definitions from gateway
    const data = await MacroAPI.getButtons('chapel');
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

    // Wire Advanced Power Settings link
    const powerLink = document.getElementById('chapel-power-link');
    if (powerLink) {
      powerLink.addEventListener('click', (e) => {
        e.preventDefault();
        MacroAPI.openPowerPanel('chapel');
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
