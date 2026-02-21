// Authentication & Permission Management
const Auth = {
  permissions: null,
  currentLocation: null,
  isAuthenticated: false,

  async init() {
    try {
      // Load permissions from gateway config endpoint (no static JSON files)
      const resp = await fetch('/api/config');
      const config = await resp.json();
      this.permissions = config.permissions || { locations: {}, defaultLocation: 'Tablet_Mainchurch' };
    } catch (e) {
      console.error('Failed to load permissions:', e);
      // Fallback: try static file (for development without gateway)
      try {
        const resp = await fetch('config/permissions.json');
        this.permissions = await resp.json();
      } catch (e2) {
        this.permissions = { locations: {}, defaultLocation: 'Tablet_Mainchurch' };
      }
    }

    // Check saved location
    const saved = localStorage.getItem('tabletLocation');
    if (saved && this.permissions.locations[saved]) {
      this.currentLocation = saved;
    } else {
      this.currentLocation = this.permissions.defaultLocation;
    }

    // Check for existing session
    const sessionToken = sessionStorage.getItem('authToken');
    if (sessionToken) {
      this.isAuthenticated = true;
    }
  },

  getLocationConfig() {
    if (!this.permissions || !this.currentLocation) return null;
    return this.permissions.locations[this.currentLocation] || null;
  },

  getDisplayName() {
    const loc = this.getLocationConfig();
    return loc ? loc.displayName : 'Unknown Location';
  },

  hasPermission(page) {
    const loc = this.getLocationConfig();
    if (!loc) return true; // Fail open if no config
    return loc.permissions[page] !== false;
  },

  getAllowedPages() {
    const loc = this.getLocationConfig();
    if (!loc) return [];
    return Object.entries(loc.permissions)
      .filter(([_, allowed]) => allowed)
      .map(([page]) => page);
  },

  setLocation(locationKey) {
    if (this.permissions.locations[locationKey]) {
      this.currentLocation = locationKey;
      localStorage.setItem('tabletLocation', locationKey);
      localStorage.setItem('tabletId', locationKey);
      return true;
    }
    return false;
  },

  getLocations() {
    if (!this.permissions) return [];
    return Object.entries(this.permissions.locations).map(([key, config]) => ({
      key,
      displayName: config.displayName
    }));
  },

  async verifyPIN(pin) {
    // Server-side PIN verification via gateway
    try {
      const resp = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
        signal: AbortSignal.timeout(3000),
      });
      const result = await resp.json();
      return result.success === true;
    } catch (e) {
      console.error('PIN verification failed:', e);
      return false;
    }
  },

  async login(pin) {
    const valid = await this.verifyPIN(pin);
    if (valid) {
      this.isAuthenticated = true;
      sessionStorage.setItem('authToken', Date.now().toString());
      return true;
    }
    return false;
  },

  logout() {
    this.isAuthenticated = false;
    sessionStorage.removeItem('authToken');
  },

  requiresPIN(page) {
    return page === 'settings';
  }
};
