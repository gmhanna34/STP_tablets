// Single Page Application Router
const Router = {
  currentPage: 'home',
  pages: {},
  onNavigate: null,

  init() {
    // Register page handlers
    this.pages = {
      home: HomePage,
      main: MainPage,
      chapel: ChapelPage,
      social: SocialPage,
      gym: GymPage,
      confroom: ConfRoomPage,
      stream: StreamPage,
      source: SourcePage,
      security: SecurityPage,
      settings: SettingsPage
    };

    // Setup nav click handlers
    document.querySelectorAll('#nav-bar .nav-item').forEach(item => {
      item.addEventListener('click', () => {
        const page = item.dataset.page;
        if (page) this.navigate(page);
      });
    });

    // Handle browser back/forward
    window.addEventListener('popstate', (e) => {
      if (e.state && e.state.page) {
        this.navigate(e.state.page, false);
      }
    });
  },

  navigate(page, pushState = true) {
    // Check permissions
    if (!Auth.hasPermission(page)) {
      console.warn(`No permission for page: ${page}`);
      return;
    }

    // Settings requires PIN
    if (Auth.requiresPIN(page) && !Auth.isAuthenticated) {
      App.showPINEntry(page);
      return;
    }

    // Stop any polling on current page
    const currentHandler = this.pages[this.currentPage];
    if (currentHandler && currentHandler.destroy) {
      currentHandler.destroy();
    }

    this.currentPage = page;

    // Update nav bar active state
    document.querySelectorAll('#nav-bar .nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });

    // Render page content
    const content = document.getElementById('page-content');
    content.innerHTML = '';
    content.className = 'fade-in';

    const handler = this.pages[page];
    if (handler && handler.render) {
      handler.render(content);
      if (handler.init) handler.init();
    } else {
      content.innerHTML = '<div class="info-text">Page not found</div>';
    }

    // Push history state
    if (pushState) {
      history.pushState({ page }, '', `#${page}`);
    }

    // Callback
    if (this.onNavigate) this.onNavigate(page);
  },

  updateNavVisibility() {
    document.querySelectorAll('#nav-bar .nav-item').forEach(item => {
      const page = item.dataset.page;
      if (page) {
        item.classList.toggle('hidden', !Auth.hasPermission(page));
      }
    });
  }
};
