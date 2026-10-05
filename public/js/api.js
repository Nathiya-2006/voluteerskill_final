/* VolunteerSkill - shared frontend API helper */
const API_BASE = '/api';

const VS = {
  getToken() { return localStorage.getItem('vs_token'); },
  getRole() { return localStorage.getItem('vs_role'); },
  getUser() {
    const raw = localStorage.getItem('vs_user');
    return raw ? JSON.parse(raw) : null;
  },
  setSession(token, role, user) {
    localStorage.setItem('vs_token', token);
    localStorage.setItem('vs_role', role);
    localStorage.setItem('vs_user', JSON.stringify(user));
  },
  clearSession() {
    localStorage.removeItem('vs_token');
    localStorage.removeItem('vs_role');
    localStorage.removeItem('vs_user');
  },
  isLoggedIn() { return !!this.getToken(); },

  async request(method, endpoint, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(API_BASE + endpoint, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    let data = {};
    try { data = await res.json(); } catch (e) { /* no body */ }

    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  get(endpoint) { return this.request('GET', endpoint); },
  post(endpoint, body) { return this.request('POST', endpoint, body); },
  put(endpoint, body) { return this.request('PUT', endpoint, body); },

  requireAuth(allowedRoles) {
    if (!this.isLoggedIn()) {
      window.location.href = 'login.html';
      return false;
    }
    if (allowedRoles && !allowedRoles.includes(this.getRole())) {
      window.location.href = this.dashboardForRole(this.getRole());
      return false;
    }
    return true;
  },

  dashboardForRole(role) {
    if (role === 'volunteer') return 'volunteer-dashboard.html';
    if (role === 'ngo') return 'ngo-dashboard.html';
    if (role === 'admin') return 'admin-dashboard.html';
    return 'login.html';
  },

  logout() {
    this.clearSession();
    window.location.href = 'login.html';
  },

  toast(message, type = 'success') {
    let container = document.getElementById('vs-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'vs-toast-container';
      container.style.position = 'fixed';
      container.style.top = '20px';
      container.style.right = '20px';
      container.style.zIndex = '2000';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = `alert alert-${type === 'error' ? 'danger' : type} shadow`;
    el.style.minWidth = '260px';
    el.innerText = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  },

  fmtDate(d) {
    if (!d) return '';
    const date = new Date(d);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  },

  starRating(rating) {
    const full = Math.round(rating || 0);
    let out = '';
    for (let i = 1; i <= 5; i++) {
      out += `<i class="fa-star ${i <= full ? 'fas text-warning' : 'far text-muted'}"></i>`;
    }
    return out;
  },

  // ---- Shared config (Google Maps key, radius options) ----
  _config: null,
  async getConfig() {
    if (this._config) return this._config;
    try { this._config = await this.get('/config'); } catch (e) { this._config = { googleMapsApiKey: null, radiusOptionsKm: [5, 10, 25, 50, 100] }; }
    return this._config;
  },

  // ---- Dynamic script loader (used for Google Maps / QR libs) ----
  _loadedScripts: {},
  loadScript(src) {
    if (this._loadedScripts[src]) return this._loadedScripts[src];
    this._loadedScripts[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(s);
    });
    return this._loadedScripts[src];
  },

  // ---------------- MAPS (Google Maps first, automatic OpenStreetMap fallback) ----------------
  mapsAuthFailed: false,
  _gmPromise: null,
  _gmRenders: [],
  _fallbackNotified: false,

  // Resolves true only if the Google Maps JS API actually loaded. Never throws.
  loadGoogleMaps() {
    if (this._gmPromise) return this._gmPromise;
    this._gmPromise = (async () => {
      const cfg = await this.getConfig();
      if (!cfg.googleMapsApiKey) return false;
      if (window.google && window.google.maps) return true;
      window.gm_authFailure = () => VS._onMapsAuthFailure();   // Google calls this when the key is rejected
      return await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 12000);
        window.__vsMapsInit = () => { clearTimeout(timer); resolve(true); };
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(cfg.googleMapsApiKey)}&libraries=places&callback=__vsMapsInit`;
        s.async = true;
        s.onerror = () => { clearTimeout(timer); resolve(false); };
        document.head.appendChild(s);
      });
    })();
    return this._gmPromise;
  },

  _onMapsAuthFailure() {
    this.mapsAuthFailed = true;
    console.error('Google Maps rejected the API key. Enable "Maps JavaScript API" (and "Places API"), turn on billing, and allow this site\'s URL (e.g. http://localhost:3000/*) in the key restrictions.');
    const pending = this._gmRenders; this._gmRenders = [];
    pending.forEach(spec => this._renderLeaflet(spec));
  },

  _loadCss(href) {
    if (document.querySelector(`link[href="${href}"]`)) return;
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; document.head.appendChild(l);
  },

  /**
   * Draws a map into the element with id elId.
   * markers: [{ lat, lng, title, label, color, radius }]  (color+radius => coloured circle, otherwise a pin)
   */
  async showMap(elId, center, markers, zoom) {
    const el = document.getElementById(elId);
    if (!el) return;
    markers = (markers || []).filter(m => m && m.lat != null && m.lng != null && !isNaN(m.lat) && !isNaN(m.lng));
    const c = center && center.lat != null ? { lat: +center.lat, lng: +center.lng } : (markers[0] ? { lat: markers[0].lat, lng: markers[0].lng } : { lat: 20.5937, lng: 78.9629 });
    const spec = { elId, center: c, markers, zoom: zoom || 10 };
    const googleOk = !this.mapsAuthFailed && await this.loadGoogleMaps();
    if (googleOk) {
      try {
        this._renderGoogle(spec);
        this._gmRenders = this._gmRenders.filter(r => r.elId !== elId).concat(spec);
        return;
      } catch (e) { console.error('Google map failed, using fallback:', e); }
    }
    await this._renderLeaflet(spec);
  },

  _renderGoogle(spec) {
    const el = document.getElementById(spec.elId);
    el.innerHTML = '';
    const map = new google.maps.Map(el, { center: spec.center, zoom: spec.zoom, mapTypeControl: false, streetViewControl: false });
    const bounds = new google.maps.LatLngBounds();
    spec.markers.forEach(m => {
      const opts = { position: { lat: m.lat, lng: m.lng }, map, title: m.title || '' };
      if (m.label) opts.label = m.label;
      if (m.color) opts.icon = { path: google.maps.SymbolPath.CIRCLE, scale: m.radius || 10, fillColor: m.color, fillOpacity: 0.7, strokeWeight: 0 };
      new google.maps.Marker(opts);
      bounds.extend(opts.position);
    });
    if (spec.markers.length > 1) {
      map.fitBounds(bounds, 40);
      google.maps.event.addListenerOnce(map, 'idle', () => { if (map.getZoom() > 15) map.setZoom(15); });
    }
    setTimeout(() => google.maps.event.trigger(map, 'resize'), 300);
  },

  async _renderLeaflet(spec) {
    const el = document.getElementById(spec.elId);
    if (!el) return;
    try {
      if (!window.L) {
        this._loadCss('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css');
        await this.loadScript('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js');
      }
      el.innerHTML = '';
      const map = L.map(el).setView([spec.center.lat, spec.center.lng], spec.zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
      const pts = [];
      spec.markers.forEach(m => {
        const ll = [m.lat, m.lng]; pts.push(ll);
        const layer = m.color
          ? L.circleMarker(ll, { radius: m.radius || 10, color: m.color, fillColor: m.color, fillOpacity: 0.7, weight: 1 })
          : L.marker(ll);
        layer.addTo(map);
        if (m.label && !m.color) layer.bindTooltip(String(m.label), { permanent: true, direction: 'top' });
        else if (m.title) layer.bindTooltip(String(m.title));
      });
      if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
      [200, 600, 1500].forEach(t => setTimeout(() => map.invalidateSize(), t));
      if (this.mapsAuthFailed && !this._fallbackNotified) {
        this._fallbackNotified = true;
        this.toast('Google Maps rejected the API key, so an OpenStreetMap map is shown instead. Check the key settings in Google Cloud Console.', 'warning');
      }
    } catch (e) {
      console.error('Map could not be drawn:', e);
      el.innerHTML = '<div class="alert alert-warning m-3 small">The map could not be loaded (check your internet connection). The list below still shows the same data.</div>';
    }
  },

  async geocode(address) {
    if (!address || !address.trim()) return null;
    try {
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(address));
      const j = await r.json();
      if (j && j[0]) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon), address: j[0].display_name };
    } catch (e) { console.error('Geocoding failed:', e); }
    return null;
  },

  /**
   * Address box: Google Places suggestions when available, otherwise the typed address is
   * geocoded (OpenStreetMap) when the user leaves the field. onSelect({lat,lng,address}) is called either way.
   */
  async attachAddressInput(inputId, onSelect) {
    const input = document.getElementById(inputId);
    if (!input) return;
    let pickedText = null;
    const ok = await this.loadGoogleMaps();
    if (ok && !this.mapsAuthFailed && window.google.maps.places && google.maps.places.Autocomplete) {
      try {
        const ac = new google.maps.places.Autocomplete(input, { fields: ['geometry', 'formatted_address'] });
        ac.addListener('place_changed', () => {
          const place = ac.getPlace();
          if (place && place.geometry) {
            pickedText = input.value;
            onSelect({ lat: place.geometry.location.lat(), lng: place.geometry.location.lng(), address: place.formatted_address });
          }
        });
      } catch (e) { console.error('Places autocomplete unavailable, using fallback:', e); }
    }
    input.addEventListener('change', async () => {
      if (!input.value.trim() || input.value === pickedText) return;
      const g = await VS.geocode(input.value);
      if (g) { pickedText = input.value; onSelect(g); VS.toast('Location found on map', 'success'); }
      else VS.toast('Could not find that address. Try adding the city and state.', 'warning');
    });
  },

  // Renders a QR code into the given element id, using a small CDN library loaded on demand.
  async renderQRCode(elId, text) {
    await this.loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js');
    const el = document.getElementById(elId);
    if (!el) return;
    el.innerHTML = '';
    // eslint-disable-next-line no-undef
    new QRCode(el, { text, width: 200, height: 200, correctLevel: QRCode.CorrectLevel.M });
  },

  distanceLabel(km) {
    if (km == null) return '';
    return km < 1 ? Math.round(km * 1000) + ' m' : km.toFixed(1) + ' km';
  },

  etaLabel(mins) {
    if (mins == null) return '';
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  },

  directionsUrl(loc) {
    if (!loc || loc.lat == null) return '#';
    return `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`;
  }
};

async function loadNotifications(badgeElId, listElId) {
  try {
    const { notifications } = await VS.get('/notifications');
    const unread = notifications.filter(n => !n.read).length;
    const badge = document.getElementById(badgeElId);
    if (badge) badge.style.display = unread > 0 ? 'inline-block' : 'none';

    const list = document.getElementById(listElId);
    if (list) {
      list.innerHTML = notifications.length
        ? notifications.slice(0, 10).map(n => `
          <div class="dropdown-item-text py-2 border-bottom ${n.read ? '' : 'bg-light'}">
            <strong>${n.title}</strong><br>
            <small class="text-muted">${n.message}</small><br>
            <small class="text-muted">${new Date(n.createdAt).toLocaleString()}</small>
          </div>`).join('')
        : '<div class="dropdown-item-text text-muted">No notifications yet.</div>';
    }
  } catch (e) { /* silent */ }
}

// Re-fit maps when a Bootstrap tab becomes visible (maps drawn inside hidden tabs render grey otherwise)
document.addEventListener('shown.bs.tab', () => setTimeout(() => window.dispatchEvent(new Event('resize')), 150));
