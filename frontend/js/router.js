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
      settings: SettingsPage,
      health: HealthPage,
      occupancy: OccupancyPage
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
      if (Auth.permissionsLoadFailed) {
        App.showToast('Cannot navigate — permissions unavailable', 3000, 'error');
      } else {
        App.showToast('Access denied for this page', 2000, 'error');
      }
      return;
    }

    // Settings requires PIN
    if (Auth.requiresPIN(page) && !Auth.isAuthenticated) {
      App.showPINEntry(page);
      return;
    }

    this._loadPage(page, pushState);
  },

  _loadPage(page, pushState = true) {
    // Stop any polling on current page + clear registered timers
    const currentHandler = this.pages[this.currentPage];
    if (currentHandler && currentHandler.destroy) {
      currentHandler.destroy();
    }
    App.clearPageTimers();

    this.currentPage = page;

    // Update nav bar active state (bottom bar + mobile drawer)
    document.querySelectorAll('#nav-bar .nav-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });
    document.querySelectorAll('#mobile-nav-drawer .drawer-item').forEach(item => {
      item.classList.toggle('active', item.dataset.page === page);
    });

    // Close mobile drawer if open
    if (App.closeMobileNav) App.closeMobileNav();

    // Render page content
    const content = document.getElementById('page-content');
    content.innerHTML = '';
    content.className = 'fade-in';

    const handler = this.pages[page];
    if (handler && handler.render) {
      handler.render(content);
      if (handler.init) {
        Promise.resolve(handler.init()).catch(e => {
          console.error(`Page ${page} init error:`, e);
          content.innerHTML += `<div style="color:#ff6b6b;padding:1em;text-align:center;">
            <p>Error loading page: ${e.message || e}</p>
            <p style="font-size:0.8em;opacity:0.7;">Check browser console for details</p>
          </div>`;
        });
      }
    } else {
      content.innerHTML = '<div class="info-text">Page not found</div>';
    }

    // Push history state
    if (pushState) {
      history.pushState({ page }, '', `${window.location.pathname}#${page}`);
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
    // Also update mobile drawer visibility
    document.querySelectorAll('#mobile-nav-drawer .drawer-item').forEach(item => {
      const page = item.dataset.page;
      if (page) {
        item.classList.toggle('hidden', !Auth.hasPermission(page));
      }
    });
  }
};
