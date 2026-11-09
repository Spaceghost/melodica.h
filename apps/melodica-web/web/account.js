// melodica-web: the optional spacegho.st account (docs/ACCOUNT.md).
//
// Signing in is optional. The policy endpoint is asked with the account's access
// token when signed in, else with the relay's access token from the Pandora login
// (x-melodica-access); the client follows the server's playback flags.
// Anything unexpected, or no token at all, is DEFAULT_POLICY.
// The username (GET /oauth/melodica/me, POST /oauth/melodica/username) is asked with
// the same bearer. No email is read or shown anywhere.
// OAuth 2.1 authorization code + PKCE (S256), public client `melodica-web`.
//
// The account server is the page's own origin (spacegho.st serves both); its
// endpoints come from /.well-known/openid-configuration and must be on that
// origin (the page's CSP is connect-src 'self'). A self-hosted copy without one
// gets no sign-in link. No DOM here, so Node can test it.

export const ACCOUNT_KEY = 'melodica.account';   // {access, refresh, expiresAt} in localStorage
export const PENDING_KEY = 'melodica.oauth';     // {state, verifier, redirectUri} in sessionStorage
export const CLIENT_ID = 'melodica-web';
export const SCOPE = 'openid profile';
export const DEFAULT_POLICY = Object.freeze({ inserts: true });
// Where an account server is expected on the page's own origin: spacegho.st, and
// localhost for development and the tests. Elsewhere (a self-hosted copy) nothing is
// probed, so no failed request shows up in the console.
export const ACCOUNT_HOSTS = ['spacegho.st', 'localhost'];

// docs/ACCOUNT.md's username format: 3 to 24 of a-z 0-9 - _, starting and ending with a
// letter or digit (case-insensitive). Reserved and taken names only the server knows.
export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;
export const USERNAME_FORMAT = 'Use 3 to 24 letters, digits, - or _, starting and ending with a letter or digit.';
export const normalizeUsername = (s) => String(s || '').trim().toLowerCase();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomString(bytes = 32, crypto = globalThis.crypto) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url(a);
}

export async function pkceChallenge(verifier, crypto = globalThis.crypto) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

// A stored JSON object, or null.
function readJson(store, key) {
  try { const v = JSON.parse(store.get(key) || 'null'); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
}

export class Account {
  // origin: the page's origin; store/session: {get,set,remove} over localStorage/sessionStorage.
  constructor({ origin, store, session, fetch: fetchImpl, now, log } = {}) {
    this.origin = origin;
    this.store = store;
    this.session = session;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.now = now || (() => Date.now());
    this.log = log || (() => {});
    this.config = null;      // discovery document, when the account server exists
    this.name = '';          // username of the signed-in account
  }

  get tokens() {
    const t = readJson(this.store, ACCOUNT_KEY);
    return t && typeof t.refresh === 'string' ? t : null;
  }
  get signedIn() { return !!this.tokens; }

  saveTokens(body) {
    const t = {
      access: String(body.access_token || ''),
      refresh: String(body.refresh_token || (this.tokens && this.tokens.refresh) || ''),
      expiresAt: this.now() + Math.max(0, Number(body.expires_in) || 0) * 1000,
    };
    if (!t.access || !t.refresh) throw new Error('the token answer had no access or refresh token');
    this.store.set(ACCOUNT_KEY, JSON.stringify(t));
    return t;
  }
  forget() {
    this.store.remove(ACCOUNT_KEY);
    this.name = '';
  }

  // The discovery document, or null when this origin has no account server.
  async discover() {
    if (this.config) return this.config;
    let host = '';
    try { host = new URL(this.origin).hostname; } catch (_) { return null; }
    if (!ACCOUNT_HOSTS.includes(host)) return null;
    let res;
    try {
      res = await this.fetch(`${this.origin}/.well-known/openid-configuration`, { cache: 'no-store' });
    } catch (_) { return null; }
    if (!res.ok) return null;
    let d;
    try { d = await res.json(); } catch (_) { return null; }
    const same = (u) => { try { return new URL(u).origin === this.origin; } catch (_) { return false; } };
    if (!d || d.issuer !== this.origin || !same(d.authorization_endpoint) || !same(d.token_endpoint)) return null;
    d.policy_endpoint = `${this.origin}/oauth/melodica/policy`;
    d.me_endpoint = `${this.origin}/oauth/melodica/me`;
    d.username_endpoint = `${this.origin}/oauth/melodica/username`;
    this.config = d;
    return d;
  }

  redirectUri() { return `${this.origin}/melodica/app/`; }

  // The authorize URL to navigate to; remembers state and verifier for the way back.
  // prompt: 'none' for a silent sign-in (docs/BRIDGE.md 4.1); the answer is a code, or
  // error=login_required without a spacegho.st session.
  async startUrl({ prompt = '' } = {}) {
    const d = await this.discover();
    if (!d) throw new Error('no account server here');
    const verifier = randomString(32);
    const state = randomString(16);
    const redirectUri = this.redirectUri();
    this.session.set(PENDING_KEY, JSON.stringify({ state, verifier, redirectUri }));
    const u = new URL(d.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri,
      code_challenge: await pkceChallenge(verifier), code_challenge_method: 'S256',
      state, scope: SCOPE, ...(prompt ? { prompt } : {}),
    }).toString();
    return u.toString();
  }

  // The same authorize round trip, by way of GitHub: spacegho.st signs in (or links)
  // the GitHub identity first, then continues to the authorize URL (a /oauth/ path).
  async githubUrl() {
    const u = new URL(await this.startUrl());
    return `${this.origin}/oauth/github/start?next=${encodeURIComponent(u.pathname + u.search)}`;
  }

  // After the authorize round trip: code/state/iss (or error) in the query. Exchanges the
  // code, cleans the address bar. Returns {done, error} ({done:false} when the URL carries
  // nothing of ours).
  async finishRedirect(location, history) {
    const q = new URLSearchParams(location.search);
    const code = q.get('code');
    const error = q.get('error');
    const iss = q.get('iss'); // read before the address bar is cleaned below
    if (!code && !error) return { done: false, error: '' };
    const pending = readJson(this.session, PENDING_KEY);
    if (!pending || q.get('state') !== pending.state) return { done: false, error: '' }; // not our round trip
    this.session.remove(PENDING_KEY);
    for (const k of ['code', 'state', 'iss', 'error', 'error_description']) q.delete(k);
    try {
      history.replaceState(history.state, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
    } catch (_) { /* the code is single use anyway */ }
    if (error) return { done: true, error: String(error).slice(0, 64) };
    const d = await this.discover();
    if (!d) return { done: true, error: 'no_account_server' };
    if (iss !== d.issuer) return { done: true, error: 'wrong_issuer' };
    const res = await this.fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri,
        client_id: CLIENT_ID, code_verifier: pending.verifier,
      }).toString(),
    });
    let body = null;
    try { body = await res.json(); } catch (_) { /* below */ }
    if (!res.ok || !body) return { done: true, error: (body && body.error) || `token_http_${res.status}` };
    this.saveTokens(body);
    this.log('signed in');
    return { done: true, error: '' };
  }

  // A fresh access token, refreshing when it expires within a minute; '' when none.
  async accessToken({ force = false } = {}) {
    const t = this.tokens;
    if (!t) return '';
    if (!force && t.access && t.expiresAt - 60_000 > this.now()) return t.access;
    const d = await this.discover();
    if (!d) return '';
    let res;
    try {
      res = await this.fetch(d.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: CLIENT_ID }).toString(),
      });
    } catch (_) { return ''; }
    let body = null;
    try { body = await res.json(); } catch (_) { /* below */ }
    if (res.ok && body && body.access_token) return this.saveTokens(body).access;
    if (body && body.error === 'invalid_grant') { this.forget(); this.log('sign-in expired; signed out'); }
    return '';
  }

  // The playback flags. relayToken is the relay's x-melodica-access token,
  // used when no account is signed in. Any failure, or no token, is DEFAULT_POLICY.
  async policy(relayToken = '') {
    const d = await this.discover();
    if (!d) return { ...DEFAULT_POLICY };
    const own = this.signedIn;
    if (!own && !relayToken) return { ...DEFAULT_POLICY };
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = own ? await this.accessToken({ force: attempt > 0 }) : relayToken;
      if (!token) return { ...DEFAULT_POLICY };
      let res;
      try {
        res = await this.fetch(d.policy_endpoint, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
      } catch (_) { return { ...DEFAULT_POLICY }; }
      if (res.status === 401 && own) continue; // refresh and retry once
      if (!res.ok) return { ...DEFAULT_POLICY };
      let body = null;
      try { body = await res.json(); } catch (_) { return { ...DEFAULT_POLICY }; }
      const playback = body && body.playback;
      if (!playback || typeof playback.plus !== 'boolean') return { ...DEFAULT_POLICY };
      const name = body.display && typeof body.display.name === 'string' ? body.display.name : '';
      if (name) this.name = name;
      return { inserts: !playback.plus };
    }
    return { ...DEFAULT_POLICY };
  }

  // The username for the account line (userinfo; best effort).
  async profile() {
    const d = await this.discover();
    const token = d && d.userinfo_endpoint ? await this.accessToken() : '';
    if (token) {
      try {
        const res = await this.fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${token}` } });
        if (res.ok) {
          const u = await res.json();
          const n = u && (u.preferred_username || u.name);
          if (typeof n === 'string' && n) this.name = this.name || n;
        }
      } catch (_) { /* name from the policy, if any, stays */ }
    }
    return { name: this.name };
  }

  // The label for the account: its username, else a neutral word.
  get label() { return this.name || 'spacegho.st account'; }

  // One call to /oauth/melodica/me or /username with the account's token when signed in,
  // else the relay's access token. Returns {status, body} (status 0: no server, no token
  // or a network error). A 401 with the account's own token refreshes and retries once.
  async melodicaCall(which, relayToken, init = {}) {
    const d = await this.discover();
    if (!d) return { status: 0, body: null, bearer: '' };
    const own = this.signedIn;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = own ? await this.accessToken({ force: attempt > 0 }) : relayToken;
      if (!token) return { status: 0, body: null, bearer: own ? 'account' : '' };
      let res;
      try {
        res = await this.fetch(d[`${which}_endpoint`], { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${token}` }, cache: 'no-store' });
      } catch (_) { return { status: 0, body: null, bearer: own ? 'account' : 'relay' }; }
      if (res.status === 401 && own && attempt === 0) continue;
      let body = null;
      try { body = await res.json(); } catch (_) { /* below */ }
      return { status: res.status, body: body && typeof body === 'object' ? body : null, bearer: own ? 'account' : 'relay' };
    }
    return { status: 401, body: { error: 'invalid_token' }, bearer: 'account' };
  }

  // GET /oauth/melodica/me -> {ok, username, chosen, suggested, notice, status, error, bearer}.
  async me(relayToken = '') {
    const r = await this.melodicaCall('me', relayToken);
    const b = r.body || {};
    if (r.status === 200 && typeof b.username === 'string' && b.username) {
      this.name = b.username;
      return {
        ok: true, status: 200, bearer: r.bearer, username: b.username, chosen: b.username_chosen === true,
        suggested: typeof b.suggested === 'string' ? b.suggested : '',
        notice: typeof b.notice === 'string' ? b.notice : '',
      };
    }
    return { ok: false, status: r.status, bearer: r.bearer, error: typeof b.error === 'string' ? b.error : '' };
  }

  // POST /oauth/melodica/username -> {ok, username} or {ok:false, status, error, message}.
  async setUsername(name, relayToken = '') {
    const r = await this.melodicaCall('username', relayToken, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name }),
    });
    const b = r.body || {};
    if (r.status === 200 && typeof b.username === 'string' && b.username) {
      this.name = b.username;
      return { ok: true, status: 200, bearer: r.bearer, username: b.username };
    }
    const message = typeof b.error_description === 'string' && b.error_description ? b.error_description
      : r.status === 0 ? 'The username service is unavailable; try again.'
        : r.status === 401 || r.status === 404 ? 'Your melodica session has ended; log in again.'
          : `The username was not saved (HTTP ${r.status}).`;
    return { ok: false, status: r.status, bearer: r.bearer, error: typeof b.error === 'string' ? b.error : '', message };
  }

  // Forget the tokens here and revoke the refresh token.
  async signOut() {
    const t = this.tokens;
    this.forget();
    const d = t ? await this.discover() : null;
    if (!d || !d.revocation_endpoint) return;
    try {
      await this.fetch(d.revocation_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh, client_id: CLIENT_ID }).toString(),
      });
    } catch (_) { /* tokens are gone locally either way */ }
  }
}
