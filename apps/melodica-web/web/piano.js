// melodica-web: thin JS wrapper around the melodica.h wasm module.
// Works in browsers and Node (no DOM use here). The protocol, including the
// Blowfish encryption of request bodies, runs inside the wasm; this file only
// moves strings across the boundary and performs HTTP through the relay.

import createMelodica from './melodica.js';

export const PIANO_RPC_PREFIX = '/services/json/?';

// Human-readable messages for Pandora error codes (the "code" field) and
// libpiano status values.
const CODE_MESSAGES = {
  0: 'Pandora reported an internal error. Try again in a moment.',
  1: 'Pandora is in maintenance mode. Try again later.',
  12: 'Pandora is only available in the US; the relay could not reach it from where it runs.',
  13: 'Insufficient connectivity between the relay and Pandora.',
  1000: 'Pandora is in read-only mode. Try again later.',
  1001: 'Your session expired. Signing in again.',
  1002: 'Invalid partner login (the client identity was rejected by Pandora).',
  1003: 'This listener is not authorized.',
  1004: 'This user is not authorized.',
  1005: 'You have reached the maximum number of stations.',
  1006: 'That station no longer exists.',
  1008: 'Pandora refused this call.',
  1009: 'Device not found.',
  1010: 'Partner not authorized.',
  1011: 'Invalid username.',
  1012: 'Invalid password.',
  1034: 'This device is disabled.',
  1035: 'Daily trial limit reached.',
  1039: 'Pandora is rate limiting this relay. Wait a minute and try again.',
};
const STATUS_MESSAGES = {
  0: 'Unknown error.',
  2: 'Pandora sent a response the client could not parse.',
  4: 'Out of memory.',
  5: 'Wrong email address or password.',
  6: 'The selected audio quality is not available for this station.',
};

export class PianoError extends Error {
  constructor(reply, extra) {
    super(PianoError.describe(reply, extra));
    this.name = 'PianoError';
    this.status = reply.status;
    this.code = reply.code;
    this.raw = reply.error;
    this.kind = extra && extra.kind ? extra.kind : 'pandora';
  }
  static describe(reply, extra) {
    if (extra && extra.message) return extra.message;
    if (reply.code !== null && reply.code !== undefined && CODE_MESSAGES[reply.code]) {
      return CODE_MESSAGES[reply.code];
    }
    if (STATUS_MESSAGES[reply.status]) return STATUS_MESSAGES[reply.status];
    if (reply.code !== null && reply.code !== undefined) {
      return `Pandora error ${reply.code}: ${reply.error || 'no message'}`;
    }
    return reply.error || 'Unknown error.';
  }
  // 1001: Pandora session expired. 'access-expired': the relay's access token
  // (x-melodica-access, 12 h) is missing or expired; a fresh login renews it.
  get needsRelogin() { return this.code === 1001 || this.kind === 'access-expired'; }
  get badCredentials() { return this.status === 5 || this.code === 1011 || this.code === 1012; }
}

export class PianoClient {
  constructor(options = {}) {
    this.apiBase = options.apiBase;          // URL string ending in '/'
    this.fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this.log = options.log || (() => {});
    // The relay's access token from the last auth.userLogin (docs/ACCOUNT.md); sent as
    // x-melodica-access on every later relay call. onAccess(token) hears each new one.
    this.accessToken = '';
    this.onAccess = options.onAccess || null;
    this.module = null;
    this.credentials = null;
    this.busy = Promise.resolve();
  }

  async load(moduleOptions = {}) {
    this.module = await createMelodica(moduleOptions);
    const m = this.module;
    this.fn = {
      init: m.cwrap('mw_init', 'number', []),
      begin: m.cwrap('mw_begin', 'number', ['number']),
      cont: m.cwrap('mw_continue', 'number', []),
      finish: m.cwrap('mw_finish', 'number', ['number']),
      free: m.cwrap('mw_free', null, ['number']),
      version: m.cwrap('mw_version', 'string', []),
      loggedIn: m.cwrap('mw_logged_in', 'number', []),
      stations: m.cwrap('mw_stations', 'number', []),
    };
    const rc = this.fn.init();
    if (rc !== 0) throw new Error(`mw_init failed with status ${rc}`);
    this.version = this.fn.version();
    return this;
  }

  // Pass a JS string into C as a malloc'd UTF-8 buffer (never the wasm stack;
  // station lists and playlists are larger than the default stack).
  withCString(str, fn) {
    const m = this.module;
    const len = m.lengthBytesUTF8(str) + 1;
    const ptr = m._malloc(len);
    try {
      m.stringToUTF8(str, ptr, len);
      return fn(ptr);
    } finally {
      m._free(ptr);
    }
  }

  takeJson(ptr) {
    const text = this.module.UTF8ToString(ptr);
    this.fn.free(ptr);
    return JSON.parse(text);
  }

  begin(request) {
    return this.takeJson(this.withCString(JSON.stringify(request), (p) => this.fn.begin(p)));
  }
  continueRequest() { return this.takeJson(this.fn.cont()); }
  finish(body) { return this.takeJson(this.withCString(body, (p) => this.fn.finish(p))); }
  get loggedIn() { return this.fn ? this.fn.loggedIn() === 1 : false; }
  cachedStations() { return this.takeJson(this.fn.stations()).stations; }

  relayUrl(urlPath) {
    const query = urlPath.startsWith(PIANO_RPC_PREFIX) ? urlPath.slice(PIANO_RPC_PREFIX.length) : urlPath;
    return `${this.apiBase}?${query}`;
  }

  // Every libpiano request goes through the relay. (With the melodica extension the
  // page does not run this client at all: it is a remote of the extension's player.)
  post(req) { return this.postRelay(req); }

  async postRelay(req) {
    const url = this.relayUrl(req.urlPath);
    const method = relayMethod(req.urlPath);
    const headers = { 'content-type': 'text/plain' };
    if (this.accessToken && !method.startsWith('auth.') && method !== 'test.checkLicensing') {
      headers['x-melodica-access'] = this.accessToken;
    }
    let res;
    try {
      res = await this.fetch(url, { method: 'POST', headers, body: req.postData });
    } catch (err) {
      throw new PianoError({ status: 0, code: null, error: String(err) }, {
        kind: 'network',
        message: `Could not reach the relay at ${this.apiBase} (${err && err.message ? err.message : err}).`,
      });
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) accessFailure(res.status, text, this);
    if (!res.ok && !text.startsWith('{')) {
      throw new PianoError({ status: 0, code: null, error: text.slice(0, 200) }, {
        kind: 'relay',
        message: `The relay at ${this.apiBase} answered HTTP ${res.status}.`,
      });
    }
    if (method === 'auth.userLogin' && res.ok) {
      const token = res.headers && res.headers.get ? res.headers.get('x-melodica-access') : null;
      if (token) {
        this.accessToken = token;
        if (this.onAccess) {
          try { this.onAccess(token); } catch (_) { /* a listener must not break the login */ }
        }
      }
    }
    return text;
  }

  // One libpiano request/response cycle, including the two-step login.
  async callOnce(request) {
    let req = this.begin(request);
    for (let i = 0; i < 4; i++) {
      if (!req.ok) throw new PianoError(req);
      this.log(`-> ${req.urlPath.split('&')[0].replace(PIANO_RPC_PREFIX, '')}`);
      const body = await this.post(req);
      const reply = this.finish(body);
      if (!reply.ok) throw new PianoError(reply);
      if (!reply.continue) return reply.result;
      req = this.continueRequest();
    }
    throw new Error('Request did not settle after four round trips.');
  }

  // Serialised: the C side holds one request at a time. Re-logs in once on
  // an expired session (Pandora code 1001), like pianobar does.
  call(request) {
    const run = async () => {
      try {
        return await this.callOnce(request);
      } catch (err) {
        if (err instanceof PianoError && err.needsRelogin && request.action !== 'login' && this.credentials) {
          this.log('session expired; signing in again');
          await this.callOnce({ action: 'login', ...this.credentials });
          if (request.action !== 'stations' && request.action !== 'login') {
            await this.callOnce({ action: 'stations' });
          }
          return await this.callOnce(request);
        }
        throw err;
      }
    };
    const next = this.busy.then(run, run);
    this.busy = next.catch(() => {});
    return next;
  }

  async login(user, password) {
    const result = await this.call({ action: 'login', user, password });
    this.credentials = { user, password };
    return result;
  }
  logout() {
    this.credentials = null;
    this.accessToken = '';
    this.fn.init();
  }
  stations() { return this.call({ action: 'stations' }).then((r) => r.stations); }
  // Songs in order, with each ad item as {isAd: true, adToken} at its place.
  playlist(stationId, quality = 'high') {
    return this.call({ action: 'playlist', stationId, quality }).then((r) => {
      const songs = Array.isArray(r.songs) ? r.songs.slice() : [];
      const ads = Array.isArray(r.ads) ? r.ads : [];
      for (const ad of [...ads].sort((a, b) => b.position - a.position)) {
        if (ad && ad.adToken) songs.splice(Math.min(Math.max(0, Number(ad.position) || 0), songs.length), 0, { isAd: true, adToken: ad.adToken, stationId });
      }
      return songs;
    });
  }
  // ad.getAdMetadata: {title, companyName, imageUrl, clickThroughUrl, audioUrl, audioFormat, adTrackingTokens}
  adMetadata(adToken, quality = 'high') { return this.call({ action: 'adMetadata', adToken, quality }); }
  // ad.registerAd after the ad started playing.
  registerAd(stationId, adTrackingTokens) { return this.call({ action: 'registerAd', stationId, adTrackingTokens }); }
  rate(song, rating) {
    return this.call({ action: 'rate', trackToken: song.trackToken, stationId: song.stationId, rating });
  }
  tired(song) { return this.call({ action: 'tired', trackToken: song.trackToken, stationId: song.stationId }); }
  explain(song) {
    return this.call({ action: 'explain', trackToken: song.trackToken, stationId: song.stationId })
      .then((r) => r.explanation);
  }
  search(query) { return this.call({ action: 'search', query }); }
  createStation(token, type) {
    return this.call({ action: 'createStation', token, type }).then((r) => r.stations);
  }
  deleteStation(stationId) {
    return this.call({ action: 'deleteStation', stationId }).then((r) => r.stations);
  }
}

// The relay's allow-list answers (docs/ACCOUNT.md: HTTP 401/403 with
// {"stat":"fail","code":-1,"message":…}) throw with that message, shown as is.
// Other 401/403 bodies return and are handled as before.
function accessFailure(status, text, client) {
  let body = null;
  try { body = JSON.parse(text); } catch (_) { return; }
  if (!body || body.stat !== 'fail' || body.code !== -1 || typeof body.message !== 'string') return;
  if (status === 401) client.accessToken = '';
  throw new PianoError({ status: 0, code: null, error: body.message }, {
    kind: status === 401 ? 'access-expired' : 'access',
    message: body.message,
  });
}

// The Pandora method of a libpiano URL path ('auth.userLogin', ...), or ''.
export function relayMethod(urlPath) {
  const m = /[?&]method=([^&]*)/.exec(urlPath || '');
  return m ? decodeURIComponent(m[1]) : '';
}

// Resolve the relay base URL: explicit value, else `../api/` relative to the
// page (https://host/melodica/app/ -> https://host/melodica/api/).
export function resolveApiBase(explicit, pageUrl) {
  const base = new URL(explicit || '../api/', pageUrl);
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.search = '';
  base.hash = '';
  return base.toString();
}
