// Authentication & Permission Management
const Auth = {
  permissions: null,
  currentLocation: null,   // slug from URL path, e.g. "chapel", "av-room"
  currentRole: null,        // resolved role key, e.g. "full_access", "chapel"
  isAuthenticated: false,

  async init() {
    try {
      // Load permissions from gateway config endpoint (no static JSON files)
      const resp = await fetch('/api/config');
      const config = await resp.json();
      this.permissions = config.permissions || { roles: {}, locations: {}, defaultRole: 'full_access' };
    } catch (e) {
      console.error('Failed to load permissions:', e);
      // Fallback: try static file (for development without gateway)
      try {
        const resp = await fetch('config/permissions.json');
        this.permissions = await resp.json();
      } catch (e2) {
        this.permissions = { roles: {}, locations: {}, defaultRole: 'full_access' };
      }
    }

    // Resolve location from URL path
    this._resolveLocation();

    // Resolve role: localStorage override > location default > global default
    this._resolveRole();

    // Check for existing session
    const sessionToken = sessionStorage.getItem('authToken');
    if (sessionToken) {
      this.isAuthenticated = true;
    }
  },

  _resolveLocation() {
    // Read location slug from URL path (first segment after /)
    const pathSegment = window.location.pathname.replace(/^\//, '').split('/')[0].toLowerCase();
    const locations = this.permissions.locations || {};

    if (pathSegment && locations[pathSegment]) {
      this.currentLocation = pathSegment;
    } else {
      // Unknown path or "/" — fall back to null (will use defaultRole)
      this.currentLocation = null;
    }
  },

  _resolveRole() {
    // Priority: localStorage override > location's defaultRole > global defaultRole
    const override = localStorage.getItem('tabletRole');
    const roles = this.permissions.roles || {};

    if (override && roles[override]) {
      this.currentRole = override;
      return;
    }

    // Clear stale override if role no longer exists
    if (override) localStorage.removeItem('tabletRole');

    const locations = this.permissions.locations || {};
    if (this.currentLocation && locations[this.currentLocation]) {
      this.currentRole = locations[this.currentLocation].defaultRole || this.permissions.defaultRole || 'full_access';
    } else {
      this.currentRole = this.permissions.defaultRole || 'full_access';
    }
  },

  getRoleConfig() {
    if (!this.permissions || !this.currentRole) return null;
    return (this.permissions.roles || {})[this.currentRole] || null;
  },

  getLocationConfig() {
    if (!this.permissions || !this.currentLocation) return null;
    return (this.permissions.locations || {})[this.currentLocation] || null;
  },

  getTabletId() {
    // Unique identity based on URL-derived location slug
    return this.currentLocation || 'unknown';
  },

  getDisplayName() {
    const loc = this.getLocationConfig();
    if (loc) return loc.displayName;
    return 'Unknown Location';
  },

  getRoleDisplayName() {
    const role = this.getRoleConfig();
    return role ? role.displayName : 'Unknown Role';
  },

  isRoleOverridden() {
    // Returns true if the user has manually overridden the role via Settings
    const override = localStorage.getItem('tabletRole');
    if (!override) return false;
    const loc = this.getLocationConfig();
    if (!loc) return true; // overriding on unknown location
    return override !== loc.defaultRole;
  },

  hasPermission(page) {
    const role = this.getRoleConfig();
    if (!role) return true; // Fail open if no config
    return role.permissions[page] !== false;
  },

  getAllowedPages() {
    const role = this.getRoleConfig();
    if (!role) return [];
    return Object.entries(role.permissions)
      .filter(([_, allowed]) => allowed)
      .map(([page]) => page);
  },

  setRole(roleKey) {
    const roles = this.permissions.roles || {};
    if (roles[roleKey]) {
      this.currentRole = roleKey;
      localStorage.setItem('tabletRole', roleKey);
      localStorage.setItem('tabletId', this.getTabletId());
      return true;
    }
    return false;
  },

  resetRole() {
    localStorage.removeItem('tabletRole');
    this._resolveRole();
    localStorage.setItem('tabletId', this.getTabletId());
  },

  getRoles() {
    if (!this.permissions || !this.permissions.roles) return [];
    return Object.entries(this.permissions.roles).map(([key, config]) => ({
      key,
      displayName: config.displayName
    }));
  },

  getLocations() {
    if (!this.permissions || !this.permissions.locations) return [];
    return Object.entries(this.permissions.locations).map(([key, config]) => ({
      key,
      displayName: config.displayName,
      defaultRole: config.defaultRole
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
